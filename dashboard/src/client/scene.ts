import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LANES, type Lane, type BridgeState } from '../shared/types.js';

const ROAD_HALF = 34;
const INTERSECTION_HALF = 8;
const STOP_T = (ROAD_HALF - INTERSECTION_HALF) / (2 * ROAD_HALF);
const CAR_Y = 0.35;
const MAX_CARS_SHOWN = 8;
const CAR_GAP_T = 3.6 / (2 * ROAD_HALF);
const SPEED_APPROACH_T = 8 / (2 * ROAD_HALF);
const SPEED_CROSS_T = 19 / (2 * ROAD_HALF);

const LANE_COLORS: Record<Lane, number> = { A: 0xf5c518, B: 0xf2f4f8, C: 0xff8a3d, D: 0xe8453c };

const LANE_FORWARD: Record<Lane, THREE.Vector3> = {
  A: new THREE.Vector3(1, 0, 0),
  C: new THREE.Vector3(-1, 0, 0),
  B: new THREE.Vector3(0, 0, 1),
  D: new THREE.Vector3(0, 0, -1),
};

interface LanePathCfg {
  axis: 'x' | 'z';
  sign: 1 | -1;
  subLaneOffsets: [number, number];
}

// Right-hand traffic: each arm's 2 sub-lanes sit on the right-hand side of
// its direction of travel, e.g. eastbound (A) keeps to the south half.
const LANE_PATHS: Record<Lane, LanePathCfg> = {
  A: { axis: 'x', sign: 1, subLaneOffsets: [2.5, 5.5] },
  C: { axis: 'x', sign: -1, subLaneOffsets: [-2.5, -5.5] },
  B: { axis: 'z', sign: 1, subLaneOffsets: [-5.5, -2.5] },
  D: { axis: 'z', sign: -1, subLaneOffsets: [2.5, 5.5] },
};

// One signal post per true corner of the intersection — each lane's stop
// line is adjacent to exactly one corner under the right-hand-traffic
// layout above (A→SW, B→NW, C→NE, D→SE).
const SIGNAL_POSITIONS: Record<Lane, [number, number]> = {
  A: [-INTERSECTION_HALF - 1.5, INTERSECTION_HALF + 1.5],
  B: [-INTERSECTION_HALF - 1.5, -INTERSECTION_HALF - 1.5],
  C: [INTERSECTION_HALF + 1.5, -INTERSECTION_HALF - 1.5],
  D: [INTERSECTION_HALF + 1.5, INTERSECTION_HALF + 1.5],
};

function pathPosition(lane: Lane, t: number, subIdx: 0 | 1, out = new THREE.Vector3()): THREE.Vector3 {
  const cfg = LANE_PATHS[lane];
  const main = cfg.sign > 0 ? -ROAD_HALF + t * 2 * ROAD_HALF : ROAD_HALF - t * 2 * ROAD_HALF;
  const offset = cfg.subLaneOffsets[subIdx];
  if (cfg.axis === 'x') out.set(main, CAR_Y, offset);
  else out.set(offset, CAR_Y, main);
  return out;
}

function buildCar(lane: Lane): THREE.Group {
  const g = new THREE.Group();
  const color = LANE_COLORS[lane];

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.5, 2.0),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.15 }),
  );
  body.position.y = 0.28;
  body.castShadow = true;

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.8, 0.4, 0.95),
    new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.4 }),
  );
  cabin.position.set(0, 0.58, -0.15);
  cabin.castShadow = true;

  const lampGeo = new THREE.SphereGeometry(0.08, 8, 8);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff8dc, emissive: 0xfff2b0, emissiveIntensity: 0.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff4d4d, emissive: 0xaa1111, emissiveIntensity: 0.5 });
  const hl1 = new THREE.Mesh(lampGeo, headMat); hl1.position.set(0.4, 0.3, -1.02);
  const hl2 = new THREE.Mesh(lampGeo, headMat); hl2.position.set(-0.4, 0.3, -1.02);
  const tl1 = new THREE.Mesh(lampGeo, tailMat); tl1.position.set(0.4, 0.3, 1.02);
  const tl2 = new THREE.Mesh(lampGeo, tailMat); tl2.position.set(-0.4, 0.3, 1.02);

  g.add(body, cabin, hl1, hl2, tl1, tl2);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), LANE_FORWARD[lane]);
  return g;
}

interface SignalMats {
  redMat: THREE.MeshStandardMaterial;
  greenMat: THREE.MeshStandardMaterial;
  redLight: THREE.PointLight;
  greenLight: THREE.PointLight;
}

function applySignalMats(mats: SignalMats, signal: 'GREEN' | 'RED'): void {
  const redOn = signal === 'RED';
  const greenOn = signal === 'GREEN';
  mats.redMat.color.set(redOn ? 0xff3b30 : 0x3a0000);
  mats.redMat.emissive.set(redOn ? 0xff3b30 : 0x2a0000);
  mats.redMat.emissiveIntensity = redOn ? 2.2 : 0.3;
  mats.redLight.intensity = redOn ? 3 : 0;
  mats.greenMat.color.set(greenOn ? 0x33e77f : 0x00331a);
  mats.greenMat.emissive.set(greenOn ? 0x33e77f : 0x002210);
  mats.greenMat.emissiveIntensity = greenOn ? 2.2 : 0.3;
  mats.greenLight.intensity = greenOn ? 3 : 0;
}

interface Car {
  id: number;
  lane: Lane;
  subIdx: 0 | 1;
  t: number;
  group: THREE.Group;
}

export class IntersectionScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private container: HTMLElement;
  private clock = new THREE.Clock();

  private cars: Record<Lane, Car[]> = { A: [], B: [], C: [], D: [] };
  private laneSignal: Record<Lane, 'GREEN' | 'RED'> = { A: 'RED', B: 'RED', C: 'RED', D: 'RED' };
  private laneTarget: Record<Lane, number> = { A: 0, B: 0, C: 0, D: 0 };
  private signalMats = {} as Record<Lane, SignalMats>;
  private nextCarId = 0;
  private resizeObserver: ResizeObserver;

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1f12);
    this.scene.fog = new THREE.Fog(0x0a1f12, 55, 130);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
    this.camera.position.set(2, 46, 50);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 24;
    this.controls.maxDistance = 105;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.target.set(0, 0, 0);

    this.buildLighting();
    this.buildGround();
    this.buildRoads();
    this.buildMarkings();
    this.buildTrees();
    LANES.forEach((lane) => this.buildSignalPost(lane));

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.renderer.setAnimationLoop(this.tick);
  }

  updateState(state: BridgeState): void {
    LANES.forEach((lane) => {
      const laneState = state.lanes[lane];
      if (!laneState) return;
      this.laneSignal[lane] = laneState.signal;
      this.laneTarget[lane] = Math.min(Math.max(0, laneState.vehicle_count), MAX_CARS_SHOWN);
      applySignalMats(this.signalMats[lane], laneState.signal);
    });
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }

  private resize = (): void => {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  };

  private tick = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    LANES.forEach((lane) => this.stepLane(lane, dt));
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private buildLighting(): void {
    this.scene.add(new THREE.HemisphereLight(0x9fd8ff, 0x2d6b30, 0.65));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.18));

    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(35, 55, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -50;
    sun.shadow.camera.right = 50;
    sun.shadow.camera.top = 50;
    sun.shadow.camera.bottom = -50;
    sun.shadow.camera.far = 150;
    this.scene.add(sun);
  }

  private buildGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 160),
      new THREE.MeshStandardMaterial({ color: 0x3d8b40, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  private buildRoads(): void {
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x454545, roughness: 0.95 });

    const horizontal = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_HALF * 2, 0.15, INTERSECTION_HALF * 2),
      asphalt,
    );
    horizontal.position.set(0, 0.075, 0);
    horizontal.receiveShadow = true;

    const segLen = ROAD_HALF - INTERSECTION_HALF;
    const vNorth = new THREE.Mesh(new THREE.BoxGeometry(INTERSECTION_HALF * 2, 0.15, segLen), asphalt);
    vNorth.position.set(0, 0.075, -(INTERSECTION_HALF + segLen / 2));
    vNorth.receiveShadow = true;
    const vSouth = vNorth.clone();
    vSouth.position.z = INTERSECTION_HALF + segLen / 2;
    vSouth.receiveShadow = true;

    this.scene.add(horizontal, vNorth, vSouth);
  }

  private addDashes(
    axis: 'x' | 'z',
    fixedCoord: number,
    color: number,
    from: number,
    to: number,
    dashLen = 2.4,
    gap = 1.6,
    thickness = 0.14,
  ): void {
    const mat = new THREE.MeshBasicMaterial({ color });
    let pos = from;
    while (pos + dashLen <= to) {
      const geo =
        axis === 'x'
          ? new THREE.BoxGeometry(dashLen, 0.02, thickness)
          : new THREE.BoxGeometry(thickness, 0.02, dashLen);
      const mesh = new THREE.Mesh(geo, mat);
      const center = pos + dashLen / 2;
      if (axis === 'x') mesh.position.set(center, 0.16, fixedCoord);
      else mesh.position.set(fixedCoord, 0.16, center);
      this.scene.add(mesh);
      pos += dashLen + gap;
    }
  }

  private buildCrosswalk(axis: 'x' | 'z', mainCoord: number): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
    const stripeCount = 6;
    const spanLen = INTERSECTION_HALF * 2 - 2;
    const stripeWidth = (spanLen / stripeCount) * 0.55;
    const start = -spanLen / 2;
    for (let i = 0; i < stripeCount; i++) {
      const c = start + (spanLen / stripeCount) * (i + 0.5);
      const geo =
        axis === 'x'
          ? new THREE.BoxGeometry(1.4, 0.02, stripeWidth)
          : new THREE.BoxGeometry(stripeWidth, 0.02, 1.4);
      const mesh = new THREE.Mesh(geo, mat);
      if (axis === 'x') mesh.position.set(mainCoord, 0.16, c);
      else mesh.position.set(c, 0.16, mainCoord);
      this.scene.add(mesh);
    }
  }

  private buildMarkings(): void {
    const yellow = 0xe8c547;
    this.addDashes('x', 0, yellow, -ROAD_HALF, -INTERSECTION_HALF, 3, 1.2, 0.18);
    this.addDashes('x', 0, yellow, INTERSECTION_HALF, ROAD_HALF, 3, 1.2, 0.18);
    this.addDashes('z', 0, yellow, -ROAD_HALF, -INTERSECTION_HALF, 3, 1.2, 0.18);
    this.addDashes('z', 0, yellow, INTERSECTION_HALF, ROAD_HALF, 3, 1.2, 0.18);

    // One dashed boundary per arm, splitting it into exactly 2 sub-lanes
    // (drawn at the midpoint between each arm's pair of sub-lane centers).
    const white = 0xd8dce0;
    [-4, 4].forEach((z) => {
      this.addDashes('x', z, white, -ROAD_HALF, -INTERSECTION_HALF - 1);
      this.addDashes('x', z, white, INTERSECTION_HALF + 1, ROAD_HALF);
    });
    [-4, 4].forEach((x) => {
      this.addDashes('z', x, white, -ROAD_HALF, -INTERSECTION_HALF - 1);
      this.addDashes('z', x, white, INTERSECTION_HALF + 1, ROAD_HALF);
    });

    const stopMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const stopA = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, INTERSECTION_HALF * 2), stopMat);
    stopA.position.set(-INTERSECTION_HALF - 0.2, 0.17, 0);
    const stopC = stopA.clone();
    stopC.position.x = INTERSECTION_HALF + 0.2;
    const stopB = new THREE.Mesh(new THREE.BoxGeometry(INTERSECTION_HALF * 2, 0.03, 0.3), stopMat);
    stopB.position.set(0, 0.17, -INTERSECTION_HALF - 0.2);
    const stopD = stopB.clone();
    stopD.position.z = INTERSECTION_HALF + 0.2;
    this.scene.add(stopA, stopC, stopB, stopD);

    this.buildCrosswalk('x', -INTERSECTION_HALF - 1);
    this.buildCrosswalk('x', INTERSECTION_HALF + 1);
    this.buildCrosswalk('z', -INTERSECTION_HALF - 1);
    this.buildCrosswalk('z', INTERSECTION_HALF + 1);
  }

  private addTree(x: number, z: number): void {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.45, 2.4, 8),
      new THREE.MeshStandardMaterial({ color: 0x5a3d24, roughness: 0.9 }),
    );
    trunk.position.set(x, 1.2, z);
    trunk.castShadow = true;

    const foliage = new THREE.Mesh(
      new THREE.SphereGeometry(2.2, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x2d6b30, roughness: 0.9 }),
    );
    foliage.position.set(x, 3.4, z);
    foliage.castShadow = true;

    this.scene.add(trunk, foliage);
  }

  private buildTrees(): void {
    const corners: [number, number][] = [
      [-24, -24],
      [24, -24],
      [-24, 24],
      [24, 24],
    ];
    corners.forEach(([x, z]) => this.addTree(x, z));
  }

  private buildSignalPost(lane: Lane): void {
    const [x, z] = SIGNAL_POSITIONS[lane];

    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.2, 4.4, 12),
      new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6, metalness: 0.2 }),
    );
    pole.position.set(x, 2.2, z);
    pole.castShadow = true;

    // Rounded, glossy housing (pill-shaped, like a real signal head).
    const housing = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.36, 1.1, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x171717, roughness: 0.3, metalness: 0.4 }),
    );
    housing.position.set(x, 4.35, z);
    housing.castShadow = true;

    // Lamps bulge slightly toward the intersection center so they read
    // clearly from the orbit camera.
    const toCenter = new THREE.Vector2(-x, -z).normalize();
    const fx = toCenter.x * 0.32;
    const fz = toCenter.y * 0.32;

    const redMat = new THREE.MeshStandardMaterial({ color: 0x3a0000, emissive: 0x2a0000, emissiveIntensity: 0.3, roughness: 0.25 });
    const amberMat = new THREE.MeshStandardMaterial({ color: 0x3a2600, emissive: 0x241800, emissiveIntensity: 0.2, roughness: 0.25 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x00331a, emissive: 0x002210, emissiveIntensity: 0.3, roughness: 0.25 });

    const lampGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const redLamp = new THREE.Mesh(lampGeo, redMat);
    redLamp.position.set(x + fx, 4.78, z + fz);
    const amberLamp = new THREE.Mesh(lampGeo, amberMat);
    amberLamp.position.set(x + fx, 4.35, z + fz);
    const greenLamp = new THREE.Mesh(lampGeo, greenMat);
    greenLamp.position.set(x + fx, 3.92, z + fz);

    const redLight = new THREE.PointLight(0xff3b30, 0, 7, 2);
    redLight.position.copy(redLamp.position);
    const greenLight = new THREE.PointLight(0x33e77f, 0, 7, 2);
    greenLight.position.copy(greenLamp.position);

    this.scene.add(pole, housing, redLamp, amberLamp, greenLamp, redLight, greenLight);
    this.signalMats[lane] = { redMat, greenMat, redLight, greenLight };
  }

  private spawnCar(lane: Lane): void {
    const subIdx = (this.cars[lane].length % 2) as 0 | 1;
    const group = buildCar(lane);
    this.scene.add(group);
    const car: Car = { id: ++this.nextCarId, lane, subIdx, t: -0.02 - Math.random() * 0.08, group };
    this.placeCar(car);
    this.cars[lane].push(car);
  }

  private removeCar(lane: Lane, car: Car): void {
    this.scene.remove(car.group);
    car.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    this.cars[lane] = this.cars[lane].filter((c) => c.id !== car.id);
  }

  private placeCar(car: Car): void {
    const t = Math.max(0, Math.min(1, car.t));
    pathPosition(car.lane, t, car.subIdx, car.group.position);
    const opacity = car.t < 0 ? 0 : car.t > 0.95 ? Math.max(0, (1.05 - car.t) / 0.1) : 1;
    car.group.visible = opacity > 0.05;
  }

  private stepLane(lane: Lane, dt: number): void {
    const signal = this.laneSignal[lane];
    const target = this.laneTarget[lane];
    let list = this.cars[lane];

    const beforeExit = list.filter((c) => c.t < 0.95).length;
    if (beforeExit < target && list.length < MAX_CARS_SHOWN + 2) {
      const need = Math.min(2, target - beforeExit);
      for (let i = 0; i < need; i++) this.spawnCar(lane);
      list = this.cars[lane];
    }

    list.sort((a, b) => b.t - a.t);

    const canCross = signal === 'GREEN';
    let queueIndex = 0;
    let prevT = Infinity;

    list.forEach((car) => {
      const pastStop = car.t >= STOP_T - 0.002;
      const maxT = prevT - CAR_GAP_T * 0.85;
      let desired = car.t;

      if (canCross || pastStop) {
        const spd = canCross ? SPEED_CROSS_T : SPEED_CROSS_T * 0.55;
        desired = car.t + spd * dt;
      } else {
        const queueT = STOP_T - queueIndex * CAR_GAP_T;
        desired = Math.min(queueT, car.t + SPEED_APPROACH_T * dt);
        queueIndex++;
      }

      car.t = Math.min(desired, maxT);
      this.placeCar(car);
      prevT = car.t;
    });

    [...this.cars[lane]].forEach((car) => {
      if (car.t >= 1.05) this.removeCar(lane, car);
    });

    list = this.cars[lane];
    if (!canCross) {
      const kept = list.filter((c) => c.t < STOP_T + 0.02);
      while (kept.length > target) {
        kept.sort((a, b) => a.t - b.t);
        const victim = kept[0];
        if (!victim) break;
        this.removeCar(lane, victim);
        kept.shift();
      }
    }
  }
}
