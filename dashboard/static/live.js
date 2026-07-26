const LANES = ['A', 'B', 'C', 'D'];
const LANE_DIR = { A: 'West', B: 'North', C: 'East', D: 'South' };
const LANE_COLOR = { A: '#3b82f6', B: '#22c55e', C: '#f59e0b', D: '#f43f5e' };
const LANE_ROOF = { A: '#2f66c9', B: '#189646', C: '#c67c08', D: '#c22f4c' };
const CONG_COLOR = { Low: '#22c55e', Medium: '#f59e0b', High: '#ef4444' };
const MAX_CARS_SHOWN = 8;
const CAR_GAP = 0.11;
const SPEED_APPROACH = 0.10;
const SPEED_CROSS = 0.30;

// Right-hand traffic: each arm's cars keep to the side matching their
// direction of travel (matches the corrected 3D scene's lane geometry).
const LANE_PATHS = {
  A: { stopT: 0.36, rot: 0,   pos: (t, i) => ({ x: 8 + t * 384, y: 212 + i * 16 }) },
  B: { stopT: 0.36, rot: 90,  pos: (t, i) => ({ x: 172 + i * 16, y: 8 + t * 384 }) },
  C: { stopT: 0.36, rot: 180, pos: (t, i) => ({ x: 392 - t * 384, y: 172 + i * 16 }) },
  D: { stopT: 0.36, rot: 270, pos: (t, i) => ({ x: 212 + i * 16, y: 392 - t * 384 }) },
};
const SIGNAL_POS = { A: { x: 146, y: 146 }, B: { x: 254, y: 146 }, C: { x: 254, y: 254 }, D: { x: 146, y: 254 } };

const animCars = { A: [], B: [], C: [], D: [] };
const laneSignal = { A: 'RED', B: 'RED', C: 'RED', D: 'RED' };
const laneTarget = { A: 0, B: 0, C: 0, D: 0 };
const laneTimer = { A: { dur: 0, endAt: 0 }, B: { dur: 0, endAt: 0 }, C: { dur: 0, endAt: 0 }, D: { dur: 0, endAt: 0 } };
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
  LANES.forEach((lane) => {
    const { x, y } = SIGNAL_POS[lane];
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

/** Realistic top-down car: rounded body, cabin, windshield, lights. */
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

function spawnCar(lane) {
  const { el, bodyEl, roofEl } = createCarEl(lane);
  const car = { id: ++nextCarId, lane, laneIdx: animCars[lane].length % 2, t: -0.02 - Math.random() * 0.08, el, bodyEl, roofEl, emergencyStyled: false };
  animCars[lane].push(car);
  return car;
}

function removeCar(lane, car) {
  if (car.el && car.el.parentNode) car.el.parentNode.removeChild(car.el);
  animCars[lane] = animCars[lane].filter((c) => c.id !== car.id);
}

function placeCar(car) {
  const path = LANE_PATHS[car.lane];
  const t = Math.max(0, Math.min(1, car.t));
  const { x, y } = path.pos(t, car.laneIdx);
  car.el.setAttribute('transform', `translate(${x},${y}) rotate(${path.rot})`);
  const op = car.t < 0 ? 0.55 : car.t > 0.95 ? Math.max(0, (1.05 - car.t) / 0.1) : 1;
  car.el.style.opacity = String(op);
}

function stepLane(lane, dt) {
  const signal = laneSignal[lane];
  const path = LANE_PATHS[lane];
  const target = laneTarget[lane];
  let list = animCars[lane];

  const beforeExit = list.filter((c) => c.t < 0.95).length;
  if (beforeExit < target && list.length < MAX_CARS_SHOWN + 2) {
    const need = Math.min(2, target - beforeExit);
    for (let i = 0; i < need; i++) spawnCar(lane);
    list = animCars[lane];
  }

  list.sort((a, b) => b.t - a.t);
  const canCross = signal === 'GREEN';
  let queueIndex = 0;
  let prevT = Infinity;
  list.forEach((car) => {
    const pastStop = car.t >= path.stopT - 0.002;
    const maxT = prevT - CAR_GAP * 0.85;
    let desired = car.t;
    if (canCross || pastStop) {
      desired = car.t + SPEED_CROSS * dt;
    } else {
      const queueT = path.stopT - queueIndex * CAR_GAP;
      desired = Math.min(queueT, car.t + SPEED_APPROACH * dt);
      queueIndex++;
    }
    car.t = Math.min(desired, maxT);
    placeCar(car);
    prevT = car.t;
  });

  [...animCars[lane]].forEach((car) => { if (car.t >= 1.05) removeCar(lane, car); });

  list = animCars[lane];
  if (!canCross) {
    const kept = list.filter((c) => c.t < path.stopT + 0.02);
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

function syncLaneTimers(state) {
  LANES.forEach((l) => {
    const d = state.lanes[l];
    if (d.signal === 'GREEN') {
      if (laneTimer[l].dur !== d.green_time) {
        laneTimer[l].dur = d.green_time;
        laneTimer[l].endAt = Date.now() + d.green_time * 1000;
      }
    } else {
      laneTimer[l].dur = 0;
      laneTimer[l].endAt = 0;
    }
  });
}

function laneRemain(l) {
  const { endAt, dur } = laneTimer[l];
  if (!dur) return { remain: 0, pct: 0 };
  const remain = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
  return { remain, pct: Math.max(0, Math.round((remain / dur) * 100)) };
}

function renderLaneCards(state) {
  const container = document.getElementById('lane-cards');
  container.innerHTML = LANES.map((l) => {
    const d = state.lanes[l];
    const isGreen = d.signal === 'GREEN';
    const signalColor = isGreen ? '#22c55e' : '#ef4444';
    const congColor = CONG_COLOR[d.congestion_label] || '#22c55e';
    const { remain, pct } = laneRemain(l);
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
            <div><div class="v">${remain}</div><div class="l">GREEN (S)</div></div>
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
      document.getElementById('emg-lane').textContent = state.emergency_lane;
    } else {
      banner.style.display = 'none';
    }
    emergencyLane = state.emergency ? state.emergency_lane : null;

    LANES.forEach((l) => {
      laneSignal[l] = state.lanes[l].signal;
      laneTarget[l] = Math.min(Math.max(0, state.lanes[l].vehicle_count), MAX_CARS_SHOWN);
      document.getElementById(`lamp-${l}`).setAttribute('fill', state.lanes[l].signal === 'GREEN' ? '#22c55e' : '#ef4444');
    });
    syncLaneTimers(state);

    document.getElementById('stat-total').textContent = state.total_vehicles;
    document.getElementById('stat-cycles').textContent = state.cycle_count;
    document.getElementById('stat-wait').textContent = metrics.avg_wait_time;
    document.getElementById('stat-update').textContent = state.last_update || '—';

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
