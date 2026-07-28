const LANES = ['A', 'B', 'C', 'D'];
const LANE_DIR = { A: 'West', B: 'North', C: 'East', D: 'South' };
const LANE_COLOR = { A: '#3b82f6', B: '#22c55e', C: '#f59e0b', D: '#f43f5e' };
const LANE_ROOF = { A: '#2f66c9', B: '#189646', C: '#c67c08', D: '#c22f4c' };
const CONG_COLOR = { Low: '#22c55e', Medium: '#f59e0b', High: '#ef4444' };
const SIGNAL_COLOR = { GREEN: '#22c55e', YELLOW: '#f59e0b', RED: '#ef4444' };

const MAX_CARS_SHOWN = 8;
const STOP_T = 0.36;           // fraction of the path where the stop line sits
const CROSS_T = 0.64;          // fraction where a turning car has finished its curve

// ── Vehicle-controller physics. The traffic light is the sole authority
// over whether a car may cross STOP_T; everything below only decides HOW
// (smoothly) a car moves within whatever the light + the car ahead allow. ──
const SAFE_GAP_T = 0.075;      // minimum bumper-to-bumper following gap (t-units)
const EXIT_CLEAR_T = 0.08;     // required clearance in the shared exit lane before entering
const MAX_SPEED_APPROACH = 0.14; // speed cap while still behind the stop line
const MAX_SPEED_OPEN = 0.30;     // speed cap once inside/through the intersection
const ACCEL = 0.45;             // t/s^2 — smooth acceleration
const DECEL = 0.9;              // t/s^2 — braking (stronger than accel, like a real driver)

// ── Geometry: each direction of travel has TWO real lanes (inner, next to
// the yellow centerline, and outer, next to the curb) — a real two-lane
// carriageway each way, like an ordinary urban arterial road. ──
const CENTER = { x: 200, y: 200 };
const IH = 46;              // intersection half-width (box spans 154-246)
const LANE_DIR_NAME = { A: 'east', B: 'south', C: 'west', D: 'north' };
const DIR_VEC = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] };
const DIR_ANGLE = { east: 0, south: 90, west: 180, north: 270 };
// Each 46-unit half of the road is split into two 23-unit lanes: inner
// (adjacent to the yellow centerline) and outer (adjacent to the curb).
// Lane-boundary dashes in live.html sit exactly at the inner/outer split.
const INNER_OFFSET = { east: 11.5, west: -11.5, south: -11.5, north: 11.5 };
const OUTER_OFFSET = { east: 34.5, west: -34.5, south: -34.5, north: 34.5 };
const RIGHT_OF = { east: 'south', south: 'west', west: 'north', north: 'east' };
const LEFT_OF = { east: 'north', north: 'west', west: 'south', south: 'east' };
const OPPOSING = { A: 'C', C: 'A', B: 'D', D: 'B' };
const MOVEMENT_PROBS = [['straight', 0.60], ['left', 0.25], ['right', 0.15]];

function crossAxisCoord(dir, side) { return 200 + (side === 'inner' ? INNER_OFFSET[dir] : OUTER_OFFSET[dir]); }
function pointAtMain(dir, mainVal, side) {
  const [dx] = DIR_VEC[dir];
  return dx !== 0 ? { x: mainVal, y: crossAxisCoord(dir, side) } : { x: crossAxisCoord(dir, side), y: mainVal };
}
function mainCoordAtEdgeStart(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1 || dy === 1) return 8;
  return 392;
}
function mainCoordAtFinalEdge(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1 || dy === 1) return 392;
  return 8;
}
function mainCoordAtStopLine(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1) return CENTER.x - IH;
  if (dx === -1) return CENTER.x + IH;
  if (dy === 1) return CENTER.y - IH;
  return CENTER.y + IH;
}
function mainCoordAtExitEntry(dir) {
  const [dx, dy] = DIR_VEC[dir];
  if (dx === 1) return CENTER.x + IH;
  if (dx === -1) return CENTER.x - IH;
  if (dy === 1) return CENTER.y + IH;
  return CENTER.y - IH;
}
function lerp(a, b, f) { return a + (b - a) * f; }
function bezierPoint(p0, p1, p2, u) {
  const mu = 1 - u;
  return { x: mu * mu * p0.x + 2 * mu * u * p1.x + u * u * p2.x, y: mu * mu * p0.y + 2 * mu * u * p1.y + u * u * p2.y };
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

  if (straight) {
    const m0 = mainCoordAtEdgeStart(originDir);
    const m1 = mainCoordAtFinalEdge(originDir);
    return { pos: pointAtMain(originDir, lerp(m0, m1, t), side), angle: DIR_ANGLE[originDir] };
  }

  if (t <= STOP_T) {
    const m0 = mainCoordAtEdgeStart(originDir);
    const m1 = mainCoordAtStopLine(originDir);
    return { pos: pointAtMain(originDir, lerp(m0, m1, t / STOP_T), side), angle: DIR_ANGLE[originDir] };
  }

  if (t <= CROSS_T) {
    const u = (t - STOP_T) / (CROSS_T - STOP_T);
    const p0 = pointAtMain(originDir, mainCoordAtStopLine(originDir), side);
    const p2 = pointAtMain(car.exitDir, mainCoordAtExitEntry(car.exitDir), side);
    const delta = car.movement === 'right' ? 90 : -90;
    return { pos: bezierPoint(p0, CENTER, p2, u), angle: DIR_ANGLE[originDir] + delta * u };
  }

  const m0 = mainCoordAtExitEntry(car.exitDir);
  const m1 = mainCoordAtFinalEdge(car.exitDir);
  const u = (t - CROSS_T) / (1 - CROSS_T);
  return { pos: pointAtMain(car.exitDir, lerp(m0, m1, u)), angle: DIR_ANGLE[car.exitDir] };
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
  const POS = { A: { x: 146, y: 146 }, B: { x: 254, y: 146 }, C: { x: 254, y: 254 }, D: { x: 146, y: 254 } };
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
  return animCars[opp].some((c) => c.movement === 'straight' && c.t > STOP_T - 0.03 && c.t < CROSS_T + 0.05);
}

/** Rule 7 / "don't block the box": before a car may cross the stop line,
 * check the SHARED exit lane it is heading for (every origin lane feeding
 * the same exitDir funnels into one outgoing lane, per spec). If another
 * car is still sitting right at that exit's entry point, hold this car
 * back rather than let it enter the intersection with nowhere to go. */
function isExitLaneBlocked(car) {
  let minT = Infinity;
  LANES.forEach((l) => {
    animCars[l].forEach((c) => {
      if (c === car) return;
      if (c.exitDir !== car.exitDir || c.laneSide !== car.laneSide) return;
      if (c.t < CROSS_T) return;
      minT = Math.min(minT, c.t);
    });
  });
  if (minT === Infinity) return false;
  return (minT - CROSS_T) < EXIT_CLEAR_T;
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
  const beforeStop = car.t < STOP_T - 0.002;
  const inIntersection = car.t >= STOP_T && car.t < CROSS_T;

  let mustHoldAtLine = false;
  let canEnter = true;

  if (beforeStop) {
    const greenOk = signal === 'GREEN';
    const leftBlocked = car.movement === 'left' && opposingStraightPresent(lane);
    const exitBlocked = emergencyLane !== lane && !leftBlocked && isExitLaneBlocked(car);
    canEnter = greenOk && !leftBlocked && !exitBlocked;
    mustHoldAtLine = !canEnter;
  }

  const followGap = isFinite(leaderT) ? (leaderT - car.t) : Infinity;
  const followCeiling = isFinite(leaderT) ? leaderT - SAFE_GAP_T : Infinity;
  const lineCeiling = mustHoldAtLine ? STOP_T - 0.004 : Infinity;
  const ceiling = Math.min(followCeiling, lineCeiling);

  const distToCeiling = Math.max(0, ceiling - car.t);
  const speedCap = isFinite(ceiling) ? speedCapForGap(distToCeiling) : Infinity;
  const cruiseCap = (inIntersection || car.t >= CROSS_T) ? MAX_SPEED_OPEN : MAX_SPEED_APPROACH;
  const targetSpeed = Math.min(cruiseCap, speedCap);

  if (car.v < targetSpeed) car.v = Math.min(targetSpeed, car.v + ACCEL * dt);
  else car.v = Math.max(targetSpeed, car.v - DECEL * dt);

  const nextT = car.t + car.v * dt;
  car.t = isFinite(ceiling) ? Math.min(nextT, ceiling) : nextT;

  // State label for diagnostics/architecture clarity — movement math above
  // is entirely gap/ceiling driven and does not depend on this value.
  if (car.t >= CROSS_T) car.state = 'EXITING';
  else if (car.t >= STOP_T) car.state = 'TURNING';
  else if (mustHoldAtLine) car.state = (followGap < (STOP_T - car.t)) ? 'QUEUED' : 'WAITING';
  else car.state = car.v < 0.015 ? 'STOPPING' : 'MOVING';
}

function stepLane(lane, dt) {
  const signal = laneSignal[lane];
  const target = laneTarget[lane];
  let list = animCars[lane];

  const beforeExit = list.filter((c) => c.t < 0.95).length;
  if (beforeExit < target && list.length < MAX_CARS_SHOWN + 2) {
    const need = Math.min(2, target - beforeExit);
    for (let i = 0; i < need; i++) spawnCar(lane);
    list = animCars[lane];
  }

  // Cars in the inner and outer lanes sit side-by-side, not nose-to-tail —
  // each sub-lane is its own independent following-chain so a car in one
  // lane is never artificially blocked by a car ahead in the other lane.
  ['inner', 'outer'].forEach((side) => {
    const group = list.filter((c) => c.laneSide === side).sort((a, b) => b.t - a.t);
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
    const kept = list.filter((c) => c.t < STOP_T + 0.02);
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
poll();
setInterval(poll, 1000);
requestAnimationFrame(animLoop);
