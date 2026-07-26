const LANES = ['A', 'B', 'C', 'D'];
const LANE_DIR = { A: 'West', B: 'North', C: 'East', D: 'South' };
let currentRange = 'today';

document.getElementById('range-today').addEventListener('click', () => setRange('today'));
document.getElementById('range-all').addEventListener('click', () => setRange('all'));

function setRange(range) {
  currentRange = range;
  document.getElementById('range-today').classList.toggle('active', range === 'today');
  document.getElementById('range-all').classList.toggle('active', range === 'all');
  loadSummary();
}

async function loadSummary() {
  try {
    const res = await fetch(`/api/reports/summary?range=${currentRange}`);
    const data = await res.json();
    document.getElementById('rep-vehicles').textContent = data.vehicles;
    document.getElementById('rep-cycles').textContent = data.cycles;
    document.getElementById('rep-incidents').textContent = data.incidents;
    document.getElementById('rep-latency').textContent = `${data.avg_latency_ms} ms`;
    document.getElementById('rep-busiest').textContent = data.busiest_lane
      ? `Busiest: Lane ${data.busiest_lane} (${LANE_DIR[data.busiest_lane]})` : '';

    const table = document.getElementById('rep-lane-table');
    table.innerHTML = '<tr><th>Lane</th><th>Avg wait</th><th>Avg vehicles</th></tr>' +
      LANES.map((l) => `<tr><td>${l} — ${LANE_DIR[l]}</td><td>${data.lanes[l].avg_wait}s</td><td>${data.lanes[l].avg_count}</td></tr>`).join('');
  } catch {
    document.getElementById('rep-vehicles').textContent = '—';
  }
}

async function loadModel() {
  try {
    const res = await fetch('/api/model');
    if (!res.ok) return;
    const m = await res.json();
    document.getElementById('model-accuracy').textContent = `${(m.accuracy * 100).toFixed(1)}%`;
    document.getElementById('model-precision').textContent = `${(m.precision_weighted * 100).toFixed(1)}%`;
    document.getElementById('model-recall').textContent = `${(m.recall_weighted * 100).toFixed(1)}%`;
    document.getElementById('model-f1').textContent = `${(m.f1_weighted * 100).toFixed(1)}%`;
    document.getElementById('model-cv').textContent = `${(m.cv_mean * 100).toFixed(1)}% (± ${(m.cv_std * 100).toFixed(2)})`;

    const entries = Object.entries(m.feature_importances).sort((a, b) => b[1] - a[1]);
    document.getElementById('model-features').innerHTML = entries.map(([name, val]) => `
      <div class="model-feature-row">
        <span class="name">${name}</span>
        <div class="model-feature-bar-wrap"><div class="model-feature-bar" style="width:${(val * 100).toFixed(1)}%"></div></div>
        <span class="pct model-feature-pct">${(val * 100).toFixed(1)}%</span>
      </div>
    `).join('');
  } catch {
    // model_metrics.json unreachable — leave placeholders
  }
}

loadSummary();
loadModel();
setInterval(loadSummary, 5000);
