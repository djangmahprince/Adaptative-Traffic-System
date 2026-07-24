import { byId } from '../dom.js';
import { LANES, LANE_LABEL, type ReportSummary, type ModelMetrics } from '../../shared/types.js';

let currentRange: 'today' | 'all' = 'today';
let wired = false;

export async function activateReports(): Promise<void> {
  wireToolbar();
  await Promise.all([loadSummary(), loadModel()]);
}

function wireToolbar(): void {
  if (wired) return;
  wired = true;
  byId<HTMLButtonElement>('report-range-today').addEventListener('click', () => setRange('today'));
  byId<HTMLButtonElement>('report-range-all').addEventListener('click', () => setRange('all'));
}

function setRange(range: 'today' | 'all'): void {
  currentRange = range;
  byId('report-range-today').classList.toggle('active', range === 'today');
  byId('report-range-all').classList.toggle('active', range === 'all');
  void loadSummary();
}

async function loadSummary(): Promise<void> {
  try {
    const res = await fetch(`/api/reports/summary?range=${currentRange}`);
    const data = (await res.json()) as ReportSummary;
    render(data);
  } catch {
    byId('rep-vehicles').textContent = '—';
  }
}

function render(data: ReportSummary): void {
  byId('rep-vehicles').textContent = String(data.vehicles);
  byId('rep-cycles').textContent = String(data.cycles);
  byId('rep-incidents').textContent = String(data.incidents);
  byId('rep-latency').textContent = `${data.avg_latency_ms} ms`;
  byId('rep-busiest').textContent = data.busiest_lane
    ? `Busiest: Lane ${data.busiest_lane} (${LANE_LABEL[data.busiest_lane]})`
    : '';

  const table = byId<HTMLTableElement>('rep-lane-table');
  table.innerHTML =
    '<tr><th>Lane</th><th>Avg wait</th><th>Avg vehicles</th></tr>' +
    LANES.map(
      (l) => `<tr><td>${l} — ${LANE_LABEL[l]}</td><td>${data.lanes[l].avg_wait}s</td><td>${data.lanes[l].avg_count}</td></tr>`,
    ).join('');
}

async function loadModel(): Promise<void> {
  try {
    const res = await fetch('/api/model');
    if (!res.ok) return;
    const m = (await res.json()) as ModelMetrics;
    byId('model-accuracy').textContent = `${(m.accuracy * 100).toFixed(1)}%`;
    byId('model-precision').textContent = `${(m.precision_weighted * 100).toFixed(1)}%`;
    byId('model-recall').textContent = `${(m.recall_weighted * 100).toFixed(1)}%`;
    byId('model-f1').textContent = `${(m.f1_weighted * 100).toFixed(1)}%`;
    byId('model-cv').textContent = `${(m.cv_mean * 100).toFixed(1)}% (± ${(m.cv_std * 100).toFixed(2)})`;

    const entries = Object.entries(m.feature_importances).sort((a, b) => b[1] - a[1]);
    byId('model-features').innerHTML = entries
      .map(
        ([name, val]) => `
        <div class="model-feature-row">
          <span class="feature-name">${name}</span>
          <div class="model-feature-bar-wrap"><div class="model-feature-bar" style="width:${(val * 100).toFixed(1)}%"></div></div>
          <span class="model-feature-pct">${(val * 100).toFixed(1)}%</span>
        </div>
      `,
      )
      .join('');
  } catch {
    // model_metrics.json not reachable — leave placeholders
  }
}
