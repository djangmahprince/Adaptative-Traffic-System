const LANES = ['A', 'B', 'C', 'D'];
const LANE_COLOR = { A: '#3b82f6', B: '#22c55e', C: '#f59e0b', D: '#f43f5e' };

function laneField(row, lane, field) {
  return row[`${lane.toLowerCase()}_${field}`];
}

function toPoints(arr, max) {
  if (!arr || !arr.length) return '';
  const n = arr.length, w = 300, h = 100, pad = 8;
  return arr.map((v, i) => {
    const x = n > 1 ? (i * (w / (n - 1))) : 0;
    const y = h - pad - ((v / (max || 1)) * (h - pad * 2));
    return `${x.toFixed(1)},${Math.max(2, y).toFixed(1)}`;
  }).join(' ');
}

function drawLines(svgId, series) {
  const svg = document.getElementById(svgId);
  svg.innerHTML = series.map((s) =>
    `<polyline points="${s.points}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" opacity="${s.opacity ?? 1}"></polyline>`
  ).join('');
}

async function loadAnalytics() {
  try {
    const [histRes, eventsRes] = await Promise.all([
      fetch('/api/history?limit=100'),
      fetch('/api/events/log?limit=50'),
    ]);
    const { cycles } = await histRes.json();
    const { events } = await eventsRes.json();
    renderCharts(cycles);
    renderTimingHistory(cycles);
    renderEventLog(events);
  } catch {
    document.getElementById('event-log').innerHTML = '<div class="event-log-row"><span class="m">Could not reach the server.</span></div>';
  }
}

function renderCharts(cycles) {
  const density = LANES.map((l) => ({ points: toPoints(cycles.map((c) => laneField(c, l, 'count')), 10), color: LANE_COLOR[l] }));
  drawLines('chart-density', density);

  const queue = LANES.map((l) => ({ points: toPoints(cycles.map((c) => laneField(c, l, 'count')), 10), color: LANE_COLOR[l], opacity: 0.85 }));
  drawLines('chart-queue', queue);

  const trend = LANES.map((l) => ({ points: toPoints(cycles.map((c) => laneField(c, l, 'level') + 1), 3), color: LANE_COLOR[l] }));
  drawLines('chart-trend', trend);

  const throughput = [];
  for (let i = 1; i < cycles.length; i++) {
    const dt = cycles[i].epoch - cycles[i - 1].epoch;
    const dv = cycles[i].total_vehicles - cycles[i - 1].total_vehicles;
    throughput.push(dt > 0 ? Math.max(0, (dv / dt) * 60) : 0);
  }
  drawLines('chart-throughput', [{ points: toPoints(throughput, Math.max(20, ...throughput, 1)), color: '#5ee6a0', width: 2.5 }]);
}

function renderTimingHistory(cycles) {
  const container = document.getElementById('timing-history');
  const recent = cycles.slice(-40);
  if (!recent.length) {
    container.innerHTML = '<span class="chart-hint">No cycles recorded yet.</span>';
    return;
  }
  container.innerHTML = recent.map((c) => {
    const color = c.emergency ? '#dc2626' : (() => {
      const activeLanes = c.phase === 0 ? ['A', 'C'] : ['B', 'D'];
      const controlling = activeLanes.reduce((best, l) => laneField(c, l, 'level') > laneField(c, best, 'level') ? l : best, activeLanes[0]);
      return LANE_COLOR[controlling];
    })();
    const width = Math.max(6, Math.min(28, (c.phase === 0 ? laneField(c, 'A', 'level') : laneField(c, 'B', 'level')) * 8 + 8));
    return `<div class="bar" style="width:${width}px;height:100%;background:${color}" title="Cycle ${c.cycle_count}"></div>`;
  }).join('');
}

function renderEventLog(events) {
  const log = document.getElementById('event-log');
  if (!events.length) {
    log.innerHTML = '<div class="event-log-row"><span class="m">No events yet.</span></div>';
    return;
  }
  log.innerHTML = events.map((e) => `
    <div class="event-log-row"><span class="t">${e.time}</span><span class="m">${e.msg}</span></div>
  `).join('');
}

loadAnalytics();
setInterval(loadAnalytics, 5000);
