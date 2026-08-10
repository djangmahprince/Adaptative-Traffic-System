const LANES = ['A', 'B', 'C', 'D'];
const LANE_DIR = { A: 'West', B: 'North', C: 'East', D: 'South' };
const LANE_COLOR = { A: '#3b82f6', B: '#22c55e', C: '#f59e0b', D: '#f43f5e' };
const LANE_ROOF = { A: '#2f66c9', B: '#189646', C: '#c67c08', D: '#c22f4c' };
const CONG_COLOR = { Low: '#22c55e', Medium: '#f59e0b', High: '#ef4444' };
const SIGNAL_COLOR = { GREEN: '#22c55e', YELLOW: '#f59e0b', RED: '#ef4444' };

const MAX_CARS_SHOWN = 8;

// ── Geometry: matches the hardware prototype — lanes A/C (the horizontal
// road) are a real two-lane-each-way carriageway; lanes B/D (the vertical
// road) are a single lane each way with just a yellow midline, i.e. a
// narrower minor road crossing a wider major road. The junction box is
// therefore a rectangle, not a square: its extent along each axis is set
// by the OTHER road's width. ──
const CENTER = { x: 200, y: 200 };
const BOX_HALF_X = 23;   // half-width of B/D's carriageway → box's X extent
const BOX_HALF_Y = 46;   // half-width of A/C's carriageway → box's Y extent
const EDGE_START = 8;
const EDGE_FINAL = 392;
const PATH_LEN = EDGE_FINAL - EDGE_START;
const LANE_DIR_NAME = { A: 'east', B: 'south', C: 'west', D: 'north' };

// ── Vehicle-controller physics. The traffic light is the sole authority
// over whether a car may cross the stop line; everything below only
// decides HOW (smoothly) a car moves within whatever the light + the car
// ahead allow. ──
//
// `car.t` positions the car's CENTER (createCarEl's body rect spans -12 to
// +12 local units, i.e. a 24-unit-long sprite straddling the origin), but
// "stop at the line" and "don't overlap the car ahead" are both bumper-to-
// something rules in real driving — so every distance below is expressed
// in real units and converted through PATH_LEN (t-units are otherwise unit-
// less and this conversion was previously skipped, which is why the front
// bumper used to sail ~10 units past the visual stop line before halting).
const CAR_LENGTH_T = 24 / PATH_LEN;        // matches the rendered sprite length
const BUMPER_GAP_T = 10 / PATH_LEN;        // realistic gap, bumper to bumper
const STOP_LINE_GAP_T = 8 / PATH_LEN;      // realistic gap, front bumper to the painted line
const SAFE_GAP_T = CAR_LENGTH_T + BUMPER_GAP_T; // center-to-center spacing that yields BUMPER_GAP_T
const STOP_MARGIN_T = CAR_LENGTH_T / 2 + STOP_LINE_GAP_T; // how far a car's CENTER must stop short of the line
const EXIT_CLEAR_T = 0.08;     // required clearance in the shared exit lane before entering
const MAX_SPEED_APPROACH = 0.14; // speed cap while still behind the stop line
const MAX_SPEED_OPEN = 0.30;     // speed cap once inside/through the intersection
const ACCEL = 0.45;             // t/s^2 — smooth acceleration
const DECEL = 0.9;              // t/s^2 — braking (stronger than accel, like a real driver)
const DIR_VEC = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const DIR_ANGLE = { east: 0, south: 90, west: 180, north: 270 };
const WIDE_DIRS = new Set(['east', 'west']); // A & C — two real lanes each way

// A/C's 46-unit-per-direction carriageway is split into two 23-unit lanes:
// inner (next to the centerline) and outer (next to the curb). B/D only
// have one 23-unit-wide lane each way, so inner/outer collapse to the same
// offset there — there is nowhere else for an "outer" lane to be.
const INNER_OFFSET = { east: 11.5, west: -11.5, south: -11.5, north: 11.5 };
const OUTER_OFFSET = { east: 34.5, west: -34.5, south: -11.5, north: 11.5 };
const RIGHT_OF = { east: 'south', south: 'west', west: 'north', north: 'east' };
const LEFT_OF = { east: 'north', north: 'west', west: 'south', south: 'east' };
const OPPOSING = { A: 'C', C: 'A', B: 'D', D: 'B' };
const MOVEMENT_PROBS = [['straight', 0.60], ['left', 0.25], ['right', 0.15]];

// Per-axis stop/cross fractions: A/C cross a narrow (46-wide) box quickly;
// B/D cross a wide (92-wide) box more slowly. Using a single shared
// fraction for both would put one axis's stop line in the wrong place.
const STOP_T_X = (CENTER.x - BOX_HALF_X - EDGE_START) / PATH_LEN;
const CROSS_T_X = (CENTER.x + BOX_HALF_X - EDGE_START) / PATH_LEN;
const STOP_T_Y = (CENTER.y - BOX_HALF_Y - EDGE_START) / PATH_LEN;
const CROSS_T_Y = (CENTER.y + BOX_HALF_Y - EDGE_START) / PATH_LEN;
function stopTFor(dir) { return WIDE_DIRS.has(dir) ? STOP_T_X : STOP_T_Y; }
function crossTFor(dir) { return WIDE_DIRS.has(dir) ? CROSS_T_X : CROSS_T_Y; }

function crossAxisCoord(dir, side) { return 200 + (side === 'inner' ? INNER_OFFSET[dir] : OUTER_OFFSET[dir]); }
function pointAtMain(dir, mainVal, side) {
  const [dx] = DIR_VEC[dir];
  return dx !== 0 ? { x: mainVal, y: crossAxisCoord(dir, side) } : { x: crossAxisCoord(dir, side), y: mainVal };
}
function mainCoordAtEdgeStart(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1 || dy === 1) return EDGE_START;
  return EDGE_FINAL;
}
function mainCoordAtFinalEdge(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1 || dy === 1) return EDGE_FINAL;
  return EDGE_START;
}
function mainCoordAtStopLine(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1) return CENTER.x - BOX_HALF_X;
  if (dx === -1) return CENTER.x + BOX_HALF_X;
  if (dy === 1) return CENTER.y - BOX_HALF_Y;
  return CENTER.y + BOX_HALF_Y;
}
function mainCoordAtExitEntry(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1) return CENTER.x + BOX_HALF_X;
  if (dx === -1) return CENTER.x - BOX_HALF_X;
  if (dy === 1) return CENTER.y + BOX_HALF_Y;
  return CENTER.y - BOX_HALF_Y;
}
function lerp(a, b, f) { return a + (b - a) * f; }
function bezierPoint(p0, p1, p2, u) {
  const mu = 1 - u;
  return { x: mu * mu * p0.x + 2 * mu * u * p1.x + u * u * p2.x, y: mu * mu * p0.y + 2 * mu * u * p1.y + u * u * p2.y };
}

/** Left turns sweep through the middle of the box (a real permissive left
 * does this — hence the opposing-straight yield check). A right turn, by
 * contrast, hugs a tight curb radius at the near corner and never goes
 * near the box's center at all. Using the same CENTER control point for
 * both (as before) made right turns bow unrealistically far into the
 * middle of the box — the same space left turns and opposing traffic use
 * — which is what let them visually intersect. This computes the near
 * corner from the origin's stop line and the exit's entry line, which are
 * always on perpendicular axes for a turn. */
const LEFT_TURN_BOW = 12; // how far a left turn's curve bows off dead-center
function turnControlPoint(originDir, exitDir, movement) {
  if (movement === 'right') {
    const originIsX = DIR_VEC[originDir][0] !== 0;
    const stopCoord = mainCoordAtStopLine(originDir);
    const exitCoord = mainCoordAtExitEntry(exitDir);
    return originIsX ? { x: stopCoord, y: exitCoord } : { x: exitCoord, y: stopCoord };
  }
  // Two opposing approaches both green at once (e.g. B & D) can each have a
  // left-turner in flight simultaneously — real intersections handle this
  // because each driver keeps to their own right of the meeting point, so
  // the two curves bow to opposite sides of center instead of crossing
  // through the exact same point. Bowing by the origin direction's
  // right-hand perpendicular reproduces that: it's opposite in sign for a
  // direction and its opposite (e.g. south vs north), so opposing lefts
  // separate automatically.
  const [dx, dy] = DIR_VEC[originDir];
  const [px, py] = [dy, -dx]; // rotate 90° — the driver's own right-hand side
  return { x: CENTER.x + px * LEFT_TURN_BOW, y: CENTER.y + py * LEFT_TURN_BOW };
}

function pickMovement() {
  const r = Math.random();
  let acc = 0;
  for (const [m, p] of MOVEMENT_PROBS) { acc += p; if (r <= acc) return m; }
  return 'straight';
}
function exitDirFor(lane, movement) {
  const origin = LANE_DIR_NAME[lane];
  if (movement === 'straight') return origin;
  return movement === 'right' ? RIGHT_OF[origin] : LEFT_OF[origin];
}

/** Returns {pos:{x,y}, angle} for a car at path-progress t in [0,1].
 * Straight movements are one continuous line; turns are a straight
 * approach, a bezier arc through the intersection, then a straight
 * departure on the new direction's lane. */
function carPositionAndAngle(car, t) {
  const originDir = LANE_DIR_NAME[car.lane];
  const straight = car.movement === 'straight';
  const side = car.laneSide;
  const stopT = stopTFor(originDir);
  const crossT = crossTFor(originDir);

  if (straight) {
    const m0 = mainCoordAtEdgeStart(originDir);
    const m1 = mainCoordAtFinalEdge(originDir);
    return { pos: pointAtMain(originDir, lerp(m0, m1, t), side), angle: DIR_ANGLE[originDir] };
  }

  if (t <= stopT) {
    const m0 = mainCoordAtEdgeStart(originDir);
    const m1 = mainCoordAtStopLine(originDir);
    return { pos: pointAtMain(originDir, lerp(m0, m1, t / stopT), side), angle: DIR_ANGLE[originDir] };
  }

  if (t <= crossT) {
    const u = (t - stopT) / (crossT - stopT);
    const p0 = pointAtMain(originDir, mainCoordAtStopLine(originDir), side);
    const p2 = pointAtMain(car.exitDir, mainCoordAtExitEntry(car.exitDir), side);
    const control = turnControlPoint(originDir, car.exitDir, car.movement);
    const delta = car.movement === 'right' ? 90 : -90;
    return { pos: bezierPoint(p0, control, p2, u), angle: DIR_ANGLE[originDir] + delta * u };
  }

  const m0 = mainCoordAtExitEntry(car.exitDir);
  const m1 = mainCoordAtFinalEdge(car.exitDir);
  const u = (t - crossT) / (1 - crossT);
  return { pos: pointAtMain(car.exitDir, lerp(m0, m1, u), side), angle: DIR_ANGLE[car.exitDir] };
}

const animCars = { A: [], B: [], C: [], D: [] };
const laneSignal = { A: 'RED', B: 'RED', C: 'RED', D: 'RED' };
const laneTarget = { A: 0, B: 0, C: 0, D: 0 };
let emergencyLane = null;
let nextCarId = 0;
let lastTs = 0;
let lastTotalVehicles = null;
let lastVehiclesAt = 0;

function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function buildSignalBadges() {
  const g = document.getElementById('signal-badges');
  g.innerHTML = '';
  // Positioned just outside each corner of the (now rectangular) box.
  const bx0 = CENTER.x - BOX_HALF_X - 8, bx1 = CENTER.x + BOX_HALF_X + 8;
  const by0 = CENTER.y - BOX_HALF_Y - 8, by1 = CENTER.y + BOX_HALF_Y + 8;
  const POS = { A: { x: bx0, y: by0 }, B: { x: bx1, y: by0 }, C: { x: bx1, y: by1 }, D: { x: bx0, y: by1 } };
  LANES.forEach((lane) => {
    const { x, y } = POS[lane];
    const group = svgEl('g', {});
    group.appendChild(svgEl('rect', { x: x - 10, y: y - 14, width: 20, height: 28, rx: 5, fill: '#1f2430', stroke: 'rgba(255,255,255,.2)', 'stroke-width': 1 }));
    const lamp = svgEl('circle', { cx: x, cy: y - 4, r: 5, fill: '#ef4444', id: `lamp-${lane}` });
    group.appendChild(lamp);
    const label = svgEl('text', { x, y: y + 11, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 800, fill: '#c7cfe0', 'font-family': 'JetBrains Mono, monospace' });
    label.textContent = lane;
    group.appendChild(label);
    g.appendChild(group);
  });
}

/** Realistic top-down car: rounded body, cabin, windshield, lights.
 * Local "front" (headlights) faces -Z equivalent, i.e. local +X here —
 * angle 0 keeps the front pointing east, matching DIR_ANGLE.east. */
function createCarEl(lane) {
  const parent = document.getElementById(`cars-${lane}`);
  const g = svgEl('g', {});
  g.appendChild(svgEl('ellipse', { cx: 1, cy: 2.5, rx: 11, ry: 5.5, fill: 'rgba(0,0,0,.35)' }));
  const body = svgEl('rect', { x: -12, y: -6.5, width: 24, height: 13, rx: 3.5, ry: 3.5, fill: LANE_COLOR[lane], stroke: 'rgba(0,0,0,.35)', 'stroke-width': 0.8 });
  g.appendChild(body);
  const roof = svgEl('rect', { x: -5, y: -5, width: 11, height: 10, rx: 2, fill: LANE_ROOF[lane], opacity: 0.95 });
  g.appendChild(roof);
  g.appendChild(svgEl('rect', { x: 4.5, y: -4.2, width: 4.5, height: 8.4, rx: 1.2, fill: '#7EB6D9', opacity: 0.9 }));
  g.appendChild(svgEl('rect', { x: -9.5, y: -3.5, width: 3.2, height: 7, rx: 0.8, fill: '#5A8FB0', opacity: 0.75 }));
  g.appendChild(svgEl('circle', { cx: 11, cy: -3.5, r: 1.2, fill: '#FFF8DC' }));
  g.appendChild(svgEl('circle', { cx: 11, cy: 3.5, r: 1.2, fill: '#FFF8DC' }));
  g.appendChild(svgEl('rect', { x: -12, y: -4.5, width: 1.6, height: 2.8, rx: 0.5, fill: '#FF4D4D' }));
  g.appendChild(svgEl('rect', { x: -12, y: 1.7, width: 1.6, height: 2.8, rx: 0.5, fill: '#FF4D4D' }));
  parent.appendChild(g);
  return { el: g, bodyEl: body, roofEl: roof };
}

/** Lane choice mirrors real driving convention: left turns commit to the
 * inner lane (next to the centerline), right turns to the outer lane
 * (next to the curb), and through traffic splits ~evenly between both so
 * neither lane sits empty. */
function laneSideFor(movement) {
  if (movement === 'left') return 'inner';
  if (movement === 'right') return 'outer';
  return Math.random() < 0.5 ? 'inner' : 'outer';
}

function spawnCar(lane) {
  const movement = pickMovement();
  const exitDir = exitDirFor(lane, movement);
  const laneSide = laneSideFor(movement);
  const { el, bodyEl, roofEl } = createCarEl(lane);
  const car = {
    id: ++nextCarId, lane, movement, exitDir, laneSide,
    t: -0.02 - Math.random() * 0.08, v: MAX_SPEED_APPROACH, state: 'MOVING',
    el, bodyEl, roofEl, emergencyStyled: false,
  };
  animCars[lane].push(car);
  return car;
}

function removeCar(lane, car) {
  if (car.el && car.el.parentNode) car.el.parentNode.removeChild(car.el);
  animCars[lane] = animCars[lane].filter((c) => c.id !== car.id);
}

function placeCar(car) {
  const t = Math.max(0, Math.min(1, car.t));
  const { pos, angle } = carPositionAndAngle(car, t);
  car.el.setAttribute('transform', `translate(${pos.x},${pos.y}) rotate(${angle})`);
  const op = car.t < 0 ? 0.55 : car.t > 0.95 ? Math.max(0, (1.05 - car.t) / 0.1) : 1;
  car.el.style.opacity = String(op);
}

/** A left-turning vehicle may not enter the intersection while a
 * straight-through vehicle from the opposing approach is inside or
 * about to be — it must wait for a safe gap, per permissive left-turn
 * rules (no protected arrow, no dedicated turn lane). */
function opposingStraightPresent(lane) {
  const opp = OPPOSING[lane];
  const dir = LANE_DIR_NAME[opp]; // always the same axis as `lane` — A<->C, B<->D
  const stopT = stopTFor(dir), crossT = crossTFor(dir);
  return animCars[opp].some((c) => c.movement === 'straight' && c.t > stopT - 0.03 && c.t < crossT + 0.05);
}

/** Rule 7 / "don't block the box" — and the actual fix for cross-traffic
 * intersecting mid-box: reserve a car's exit lane for the car's WHOLE
 * transit, not just the tail end of it. Every green phase runs two
 * approaches at once (e.g. A & C), and each has a right-turner whose exit
 * is the SAME shared lane an opposing left-turner is heading for (A-right
 * and C-left both feed B; A-left and C-right both feed D, etc). Right
 * turns don't yield to opposing straight traffic like left turns do, and
 * the old version of this check only looked at cars already PAST their
 * curve — so two cars from different approaches could both be mid-curve,
 * converging on the same exit, at the same time. Blocking entry for as
 * long as any OTHER-lane car is anywhere between committing to enter and
 * clearing the exit closes that gap: only one car (per exit/lane-side)
 * is ever mid-transit toward a given exit. Same-lane traffic is excluded
 * — that's already governed by the ordinary following-distance chain and
 * would otherwise get double-gated for no reason. */
function isExitLaneBlocked(car) {
  // B/D's exit has only one physical lane, so ANY car heading there counts
  // regardless of nominal laneSide; A/C's exit has two, so only the
  // matching sub-lane counts.
  const exitIsWide = WIDE_DIRS.has(car.exitDir);
  let blocked = false;
  LANES.forEach((l) => {
    if (blocked || l === car.lane) return;
    animCars[l].forEach((c) => {
      if (blocked) return;
      if (c.exitDir !== car.exitDir) return;
      if (exitIsWide && c.laneSide !== car.laneSide) return;
      const cOriginDir = LANE_DIR_NAME[c.lane];
      const cFrontCommitT = stopTFor(cOriginDir) - CAR_LENGTH_T / 2;
      const cCrossT = crossTFor(cOriginDir);
      if (c.t < cFrontCommitT) return; // hasn't committed to entering yet
      if (c.t >= cCrossT + EXIT_CLEAR_T) return; // fully clear of the merge zone
      blocked = true;
    });
  });
  return blocked;
}

/** Safe-stopping-distance speed cap: the faster a car is allowed to go,
 * the more room it needs to brake to a smooth stop at `ceiling`. Deriving
 * the cap from DECEL (rather than a flat constant) is what gives natural,
 * physical deceleration instead of an instant speed change. */
function speedCapForGap(gap) {
  return Math.sqrt(2 * DECEL * gap);
}

/** Per-vehicle controller. Every car independently re-evaluates, every
 * frame: the light for ITS lane, whether it must yield (permissive left
 * turns), whether its destination exit lane has room, and the gap to the
 * car directly ahead of it — then picks a target speed and eases toward
 * it with bounded acceleration/braking. The traffic light can only ever
 * make a car's ceiling MORE restrictive; nothing here can move a car past
 * a red/yellow stop line or through a car ahead of it. */
function updateCarState(car, leaderT, lane, signal, dt) {
  const originDir = LANE_DIR_NAME[lane];
  const stopT = stopTFor(originDir);
  const crossT = crossTFor(originDir);
  // frontCommitT: once the car's FRONT BUMPER (center + half its length)
  // reaches the physical stop line, it is committed and must never be
  // re-gated (requirement 8 — already-crossed cars finish safely).
  // stopCeilingT: where a BLOCKED car's center actually halts — set back
  // far enough that its front bumper stops short of the line by a small,
  // realistic gap (requirement 2), not sitting on top of it.
  const frontCommitT = stopT - CAR_LENGTH_T / 2;
  const stopCeilingT = stopT - STOP_MARGIN_T;
  const beforeStop = car.t < frontCommitT;
  const inIntersection = car.t >= frontCommitT && car.t < crossT;

  let mustHoldAtLine = false;
  let canEnter = true;

  if (beforeStop) {
    const greenOk = signal === 'GREEN';
    const leftBlocked = car.movement === 'left' && opposingStraightPresent(lane);
    const exitBlocked = emergencyLane !== lane && !leftBlocked && isExitLaneBlocked(car);
    canEnter = greenOk && !leftBlocked && !exitBlocked;
    mustHoldAtLine = !canEnter;
  }

  const followCeiling = isFinite(leaderT) ? leaderT - SAFE_GAP_T : Infinity;
  const lineCeiling = mustHoldAtLine ? stopCeilingT : Infinity;
  const ceiling = Math.min(followCeiling, lineCeiling);

  // Smoothly bring the car's speed toward zero as it nears whichever
  // ceiling binds (stop line or car ahead) — this is what makes braking
  // begin naturally well before the stop line rather than an abrupt halt
  // right at it (requirement 3).
  const distToCeiling = Math.max(0, ceiling - car.t);
  const speedCap = isFinite(ceiling) ? speedCapForGap(distToCeiling) : Infinity;
  const cruiseCap = (inIntersection || car.t >= crossT) ? MAX_SPEED_OPEN : MAX_SPEED_APPROACH;
  const targetSpeed = Math.min(cruiseCap, speedCap);

  if (car.v < targetSpeed) car.v = Math.min(targetSpeed, car.v + ACCEL * dt);
  else car.v = Math.max(targetSpeed, car.v - DECEL * dt);

  const nextT = car.t + car.v * dt;
  // Hard clamp: whatever the speed model computes, the car's position this
  // frame can never exceed the ceiling — this is the actual guarantee that
  // a blocked car's front bumper never reaches, let alone crosses, the
  // stop line, regardless of dt size or approach speed.
  car.t = isFinite(ceiling) ? Math.min(nextT, ceiling) : nextT;

  // State label for diagnostics/architecture clarity — movement math above
  // is entirely gap/ceiling driven and does not depend on this value.
  if (car.t >= crossT) car.state = 'EXITING';
  else if (car.t >= frontCommitT) car.state = 'TURNING';
  else if (mustHoldAtLine) car.state = (followCeiling < lineCeiling) ? 'QUEUED' : 'WAITING';
  else car.state = car.v < 0.015 ? 'STOPPING' : 'MOVING';
}

function stepLane(lane, dt) {
  const signal = laneSignal[lane];
  const target = laneTarget[lane];
  const originDir = LANE_DIR_NAME[lane];
  const frontCommitT = stopTFor(originDir) - CAR_LENGTH_T / 2;
  let list = animCars[lane];

  const beforeExit = list.filter((c) => c.t < 0.95).length;
  if (beforeExit < target && list.length < MAX_CARS_SHOWN + 2) {
    const need = Math.min(2, target - beforeExit);
    for (let i = 0; i < need; i++) spawnCar(lane);
    list = animCars[lane];
  }

  // A/C have two real lanes side-by-side, not nose-to-tail — each sub-lane
  // is its own independent following-chain so a car in one lane is never
  // artificially blocked by a car ahead in the other lane. B/D only have
  // one physical lane each way, so ALL of a lane's cars share a single
  // following-chain regardless of their nominal laneSide.
  const sides = WIDE_DIRS.has(originDir) ? ['inner', 'outer'] : ['single'];
  sides.forEach((side) => {
    const group = (side === 'single' ? list.slice() : list.filter((c) => c.laneSide === side))
      .sort((a, b) => b.t - a.t);
    // Snapshot pre-frame positions so every car reacts to where the vehicle
    // ahead of it WAS at the start of this tick, not where it just moved to
    // a moment ago in this same pass — otherwise gap-opening propagates
    // instantly down the queue and the whole line accelerates in lockstep
    // instead of discharging as a realistic, staggered wave.
    const tSnapshot = group.map((c) => c.t);
    group.forEach((car, idx) => {
      const leaderT = idx === 0 ? Infinity : tSnapshot[idx - 1];
      updateCarState(car, leaderT, lane, signal, dt);
      placeCar(car);
    });
  });

  [...animCars[lane]].forEach((car) => { if (car.t >= 1.05) removeCar(lane, car); });

  list = animCars[lane];
  const canCross = signal === 'GREEN';
  if (!canCross) {
    const kept = list.filter((c) => c.t < frontCommitT + 0.02);
    while (kept.length > target) {
      kept.sort((a, b) => a.t - b.t);
      const victim = kept[0];
      if (!victim) break;
      removeCar(lane, victim);
      kept.shift();
    }
  }

  // Emergency vehicle styling: recolor the frontmost car when this lane
  // currently holds emergency priority. Real data only marks a lane as
  // "emergency", not an individual vehicle, so the frontmost queued car
  // stands in visually for the detected vehicle.
  const sorted = [...animCars[lane]].sort((a, b) => b.t - a.t);
  sorted.forEach((car, idx) => {
    const shouldBeEmergency = emergencyLane === lane && idx === 0;
    if (car.emergencyStyled !== shouldBeEmergency) {
      car.emergencyStyled = shouldBeEmergency;
      car.bodyEl.setAttribute('fill', shouldBeEmergency ? '#f8fafc' : LANE_COLOR[lane]);
      car.bodyEl.setAttribute('stroke', shouldBeEmergency ? '#dc2626' : 'rgba(0,0,0,.35)');
      car.bodyEl.setAttribute('stroke-width', shouldBeEmergency ? '1.4' : '0.8');
      car.roofEl.setAttribute('fill', shouldBeEmergency ? '#dc2626' : LANE_ROOF[lane]);
    }
  });
}

function animLoop(ts) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  LANES.forEach((lane) => stepLane(lane, dt));
  requestAnimationFrame(animLoop);
}

function formatPhaseState(state) {
  const ps = state.phase_state;
  if (!ps) return '—';
  if (ps.startsWith('EMG_')) {
    const sub = ps.split('_')[1];
    return `EMERGENCY — Lane ${state.emergency_lane} ${sub === 'ALL' ? 'CLEARING' : sub}`;
  }
  const road = ps.startsWith('NS') ? 'North-South' : 'East-West';
  const sub = ps.endsWith('GREEN') ? 'GREEN' : ps.endsWith('YELLOW') ? 'YELLOW' : 'ALL-RED';
  return `${road} — ${sub}`;
}

function renderLaneCards(state) {
  const container = document.getElementById('lane-cards');
  container.innerHTML = LANES.map((l) => {
    const d = state.lanes[l];
    const signalColor = SIGNAL_COLOR[d.signal] || '#ef4444';
    const congColor = CONG_COLOR[d.congestion_label] || '#22c55e';
    const remain = d.green_time; // server-computed remaining seconds; 0 unless GREEN/YELLOW
    const pct = state.phase_duration ? Math.max(0, Math.round((remain / state.phase_duration) * 100)) : 0;
    return `
      <div class="lane-card" style="margin-bottom:12px">
        <div class="accent" style="background:${signalColor}"></div>
        <div class="body">
          <div class="head">
            <div><span class="label">Lane ${l}</span><span class="dir">${LANE_DIR[l]}</span></div>
            <span class="cong-badge" style="background:${congColor}22;color:${congColor}">${d.congestion_label.toUpperCase()}</span>
          </div>
          <div class="stat-row">
            <div><div class="v">${d.vehicle_count}</div><div class="l">VEHICLES</div></div>
            <div><div class="v">${d.avg_wait_time.toFixed(1)}</div><div class="l">WAIT (S)</div></div>
            <div><div class="v">${remain}</div><div class="l">${d.signal === 'YELLOW' ? 'YELLOW (S)' : 'GREEN (S)'}</div></div>
            <div><div class="v signal" style="color:${signalColor}">${d.signal}</div><div class="l">SIGNAL</div></div>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${signalColor}"></div></div>
        </div>
      </div>`;
  }).join('');
}

function setOverrideStatus(msg, kind) {
  const el = document.getElementById('override-status');
  el.textContent = msg;
  el.className = 'override-status' + (kind ? ` ${kind}` : '');
}

async function sendOverride(body) {
  try {
    const res = await fetch('/api/override', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setOverrideStatus(err.error || 'Request failed', 'error');
      return;
    }
    setOverrideStatus('Applied', 'ok');
  } catch {
    setOverrideStatus('Server unreachable', 'error');
  }
}

document.getElementById('btn-emergency').addEventListener('click', () => {
  const lane = document.getElementById('override-lane').value;
  sendOverride({ action: 'emergency', lane });
});
document.getElementById('btn-congestion').addEventListener('click', () => {
  const lane = document.getElementById('override-lane').value;
  sendOverride({ action: 'congestion', lane, level: 2 });
});
document.getElementById('btn-reset').addEventListener('click', () => {
  sendOverride({ action: 'reset' });
});

let activeScenario = null;

async function sendScenario(body) {
  try {
    const res = await fetch('/api/scenario', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setOverrideStatus(err.error || 'Request failed', 'error');
      return;
    }
    setOverrideStatus('Applied', 'ok');
  } catch {
    setOverrideStatus('Server unreachable', 'error');
  }
}

function highlightActiveScenario() {
  document.querySelectorAll('.scenario-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.key === activeScenario);
  });
}

/** Scenario buttons are built from /api/scenarios (server.py's SCENARIOS is
 * the single source of truth for the label/description text) rather than
 * duplicated here — click one to switch, no separate terminal needed. */
async function buildScenarioButtons() {
  try {
    const res = await fetch('/api/scenarios');
    const { scenarios } = await res.json();
    const bar = document.getElementById('scenario-bar');
    const stopBtn = document.getElementById('btn-scenario-stop');
    scenarios.forEach((s) => {
      const btn = document.createElement('button');
      btn.className = 'scenario-btn';
      btn.dataset.key = s.key;
      btn.innerHTML = `${s.label}<span class="desc">${s.description}</span>`;
      btn.addEventListener('click', () => {
        activeScenario = s.key; // optimistic; poll() reconciles with the server
        highlightActiveScenario();
        sendScenario({ action: 'start', name: s.key });
      });
      bar.insertBefore(btn, stopBtn);
    });
  } catch (err) {
    console.warn('failed to load scenarios', err);
  }
}

document.getElementById('btn-scenario-stop').addEventListener('click', () => {
  activeScenario = null;
  highlightActiveScenario();
  sendScenario({ action: 'stop' });
});

async function poll() {
  try {
    const [stateRes, metricsRes] = await Promise.all([fetch('/api/state'), fetch('/api/metrics')]);
    const state = await stateRes.json();
    const metrics = await metricsRes.json();
    setConnectionBadges(state);

    const banner = document.getElementById('emergency-banner');
    if (state.emergency && state.emergency_lane) {
      banner.style.display = 'block';
      banner.classList.remove('banner-pending');
      banner.textContent = `EMERGENCY VEHICLE DETECTED — Lane ${state.emergency_lane} Priority Active`;
    } else if (state.pending_emergency) {
      banner.style.display = 'block';
      banner.classList.add('banner-pending');
      banner.textContent = `Emergency requested for Lane ${state.pending_emergency.lane} — activating once the current phase clears safely`;
    } else {
      banner.style.display = 'none';
    }
    emergencyLane = state.emergency ? state.emergency_lane : null;

    if (activeScenario !== state.active_scenario) {
      activeScenario = state.active_scenario;
      highlightActiveScenario();
    }

    LANES.forEach((l) => {
      laneSignal[l] = state.lanes[l].signal;
      laneTarget[l] = Math.min(Math.max(0, state.lanes[l].vehicle_count), MAX_CARS_SHOWN);
      document.getElementById(`lamp-${l}`).setAttribute('fill', SIGNAL_COLOR[state.lanes[l].signal] || '#ef4444');
    });

    document.getElementById('stat-total').textContent = state.total_vehicles;
    document.getElementById('stat-cycles').textContent = state.cycle_count;
    document.getElementById('stat-wait').textContent = metrics.avg_wait_time;
    document.getElementById('stat-update').textContent = state.last_update || '—';

    const phaseChip = document.getElementById('phase-chip');
    if (phaseChip) phaseChip.textContent = formatPhaseState(state);

    const latest = state.events.find((e) => e.category === 'decision' || !e.category);
    document.getElementById('ai-decision-msg').textContent = latest ? latest.msg : 'Waiting for first decision…';
    let peak = 'A';
    LANES.forEach((l) => { if (state.lanes[l].congestion_level >= state.lanes[peak].congestion_level) peak = l; });
    document.getElementById('ai-confidence').textContent = `${Math.round((state.lanes[peak].confidence || 0) * 100)}%`;
    document.getElementById('ai-emergency').textContent = state.emergency ? 'YES' : 'NO';

    const now = Date.now();
    if (lastTotalVehicles != null) {
      const dv = state.total_vehicles - lastTotalVehicles;
      if (dv > 0) {
        const dt = (now - lastVehiclesAt) / 1000;
        const perMin = dt > 0 ? Math.max(0, Math.round((dv / dt) * 60)) : 0;
        document.getElementById('ai-throughput').textContent = `${perMin} veh/min`;
        document.getElementById('synced-label').textContent = `SYNCED · ${perMin} veh/min`;
        lastVehiclesAt = now;
      }
    } else {
      lastVehiclesAt = now;
    }
    lastTotalVehicles = state.total_vehicles;

    renderLaneCards(state);
  } catch (err) {
    console.warn('poll error', err);
  }
}

buildSignalBadges();
buildScenarioButtons();
poll();
setInterval(poll, 1000);
requestAnimationFrame(animLoop);
