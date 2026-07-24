import { Chart } from 'chart.js/auto';
import { byId } from '../dom.js';
import { LANES, type CycleRow, type EventEntry, type Lane } from '../../shared/types.js';

const LANE_COLOR: Record<Lane, string> = { A: '#58a6ff', B: '#00c878', C: '#ffa502', D: '#ff4757' };

let densityChart: Chart | null = null;
let queueChart: Chart | null = null;
let trendChart: Chart | null = null;
let throughputChart: Chart | null = null;

function laneNum(row: CycleRow, lane: Lane, field: 'count' | 'wait' | 'level' | 'confidence'): number {
  const key = `${lane.toLowerCase()}_${field}` as keyof CycleRow;
  return row[key] as number;
}

export async function activateAnalytics(): Promise<void> {
  try {
    const [histRes, eventsRes] = await Promise.all([
      fetch('/api/history?limit=100'),
      fetch('/api/events/log?limit=50'),
    ]);
    const { cycles } = (await histRes.json()) as { cycles: CycleRow[] };
    const { events } = (await eventsRes.json()) as { events: EventEntry[] };
    renderCharts(cycles);
    renderTimingHistory(cycles);
    renderEventLog(events);
  } catch {
    byId('analytics-log').innerHTML =
      '<div class="event-item"><span class="event-msg">Could not reach the dashboard server.</span></div>';
  }
}

function buildChart(
  canvasId: string,
  datasets: { label: string; data: number[]; color: string }[],
  opts: { yMax?: number; tickLabels?: string[]; showLegend?: boolean } = {},
): Chart {
  const ctx = byId<HTMLCanvasElement>(canvasId).getContext('2d')!;
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: (datasets[0]?.data ?? []).map(() => ''),
      datasets: datasets.map((d) => ({
        label: d.label,
        data: d.data,
        borderColor: d.color,
        backgroundColor: `${d.color}22`,
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
        fill: false,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        y: opts.yMax != null
          ? {
              min: 0,
              max: opts.yMax,
              ticks: {
                stepSize: 1,
                color: '#8b949e',
                callback: (v) => opts.tickLabels?.[Math.round(Number(v))] ?? String(v),
              },
              grid: { color: 'rgba(255,255,255,0.06)' },
            }
          : { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: 'rgba(255,255,255,0.06)' } },
        x: { display: false },
      },
      plugins: {
        legend: opts.showLegend
          ? { position: 'bottom', labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 12 } }
          : { display: false },
      },
    },
  });
}

function renderCharts(cycles: CycleRow[]): void {
  densityChart?.destroy();
  queueChart?.destroy();
  trendChart?.destroy();
  throughputChart?.destroy();

  densityChart = buildChart(
    'chart-density',
    LANES.map((l) => ({ label: `Lane ${l}`, data: cycles.map((c) => laneNum(c, l, 'level')), color: LANE_COLOR[l] })),
    { yMax: 2.2, tickLabels: ['Low', 'Med', 'High'], showLegend: true },
  );

  queueChart = buildChart(
    'chart-queue',
    LANES.map((l) => ({ label: `Lane ${l}`, data: cycles.map((c) => laneNum(c, l, 'count')), color: LANE_COLOR[l] })),
    { showLegend: true },
  );

  const avgLevel = cycles.map(
    (c) => LANES.reduce((sum, l) => sum + laneNum(c, l, 'level'), 0) / LANES.length,
  );
  trendChart = buildChart('chart-trend', [{ label: 'Avg congestion', data: avgLevel, color: '#00c878' }], {
    yMax: 2.2,
    tickLabels: ['Low', 'Med', 'High'],
  });

  const throughput: number[] = [];
  for (let i = 1; i < cycles.length; i++) {
    const dt = cycles[i].epoch - cycles[i - 1].epoch;
    const dv = cycles[i].total_vehicles - cycles[i - 1].total_vehicles;
    throughput.push(dt > 0 ? Math.max(0, (dv / dt) * 60) : 0);
  }
  throughputChart = buildChart('chart-throughput', [{ label: 'Vehicles/min', data: throughput, color: '#58a6ff' }]);
}

function renderTimingHistory(cycles: CycleRow[]): void {
  const container = byId('timing-history');
  const recent = cycles.slice(-80);
  if (recent.length === 0) {
    container.innerHTML = '<span class="hint-text">No cycles recorded yet.</span>';
    return;
  }
  container.innerHTML = recent
    .map((c) => {
      if (c.emergency) {
        return `<div class="timing-block" style="background:${LANE_COLOR.D}" title="Emergency override — Lane ${c.emergency_lane}, cycle ${c.cycle_count}"></div>`;
      }
      const activeLanes: Lane[] = c.phase === 0 ? ['A', 'C'] : ['B', 'D'];
      const controlling = activeLanes.reduce((best, l) =>
        laneNum(c, l, 'level') > laneNum(c, best, 'level') ? l : best, activeLanes[0]);
      return `<div class="timing-block" style="background:${LANE_COLOR[controlling]}" title="Lane ${controlling} priority — cycle ${c.cycle_count}"></div>`;
    })
    .join('');
}

function renderEventLog(events: EventEntry[]): void {
  const log = byId('analytics-log');
  if (!events.length) {
    log.innerHTML = '<div class="event-item"><span class="event-msg">No events yet.</span></div>';
    return;
  }
  log.innerHTML = events
    .map(
      (e) => `
      <div class="event-item">
        <span class="event-time">${e.time}</span>
        <span class="event-msg">${e.msg}</span>
      </div>
    `,
    )
    .join('');
}
