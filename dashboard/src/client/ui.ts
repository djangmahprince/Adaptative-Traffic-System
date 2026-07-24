import { Chart } from 'chart.js/auto';
import { LANES, type Lane, type BridgeState, type DashboardPayload } from '../shared/types.js';
import { byId } from './dom.js';

const PHASE_H: Lane[] = ['A', 'C'];
const PHASE_V: Lane[] = ['B', 'D'];
const MAX_HISTORY = 30;
const AMBER_TIME_VIS = 3;

type PhaseType = 'horizontal' | 'vertical' | 'emergency' | 'unknown';

interface PhaseInfo {
  type: PhaseType;
  label: string;
  activeLanes: Lane[];
  nextLabel: string;
}

function derivePhase(lanes: BridgeState['lanes'], emergency: boolean, emergencyLane: Lane | null): PhaseInfo {
  if (emergency && emergencyLane) {
    return {
      type: 'emergency',
      label: `Emergency — Lane ${emergencyLane} priority`,
      activeLanes: [emergencyLane],
      nextLabel: 'Normal rotation after clearance',
    };
  }
  const isGreen = (l: Lane) => lanes[l].signal === 'GREEN';
  const hGreen = PHASE_H.every(isGreen);
  const vGreen = PHASE_V.every(isGreen);

  if (hGreen) {
    return { type: 'horizontal', label: 'West & East GREEN', activeLanes: PHASE_H, nextLabel: 'North & South green next' };
  }
  if (vGreen) {
    return { type: 'vertical', label: 'North & South GREEN', activeLanes: PHASE_V, nextLabel: 'West & East green next' };
  }
  return { type: 'unknown', label: 'Mixed signals', activeLanes: LANES.filter(isGreen), nextLabel: '—' };
}

function maxGreenAmong(lanes: BridgeState['lanes'], laneIds: Lane[]): number {
  let max = 0;
  laneIds.forEach((l) => {
    const gt = lanes[l]?.green_time ?? 0;
    if (gt > max) max = gt;
  });
  return max || 10;
}

export class DashboardUI {
  private history: Record<Lane, number[]> = { A: [], B: [], C: [], D: [] };
  private chart: Chart;
  private lastPhaseKey = '';
  private lastGreenTime = 0;
  private phaseEndAt = 0;
  private phaseDurationSec = 10;
  private lastGreenH = 10;
  private lastGreenV = 10;
  private lastTotalVehicles: number | null = null;
  private lastVehiclesAt = 0;

  constructor() {
    this.updateHeaderClock();
    setInterval(() => this.updateHeaderClock(), 1000);
    setInterval(() => this.tickCountdown(), 250);

    const ctx = byId<HTMLCanvasElement>('historyChart').getContext('2d')!;
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(MAX_HISTORY).fill(''),
        datasets: [
          { label: 'Lane A', data: [], borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.08)', tension: 0.4, pointRadius: 2, fill: false },
          { label: 'Lane B', data: [], borderColor: '#00c878', backgroundColor: 'rgba(0,200,120,0.08)', tension: 0.4, pointRadius: 2, fill: false },
          { label: 'Lane C', data: [], borderColor: '#ffa502', backgroundColor: 'rgba(255,165,2,0.08)', tension: 0.4, pointRadius: 2, fill: false },
          { label: 'Lane D', data: [], borderColor: '#ff4757', backgroundColor: 'rgba(255,71,87,0.08)', tension: 0.4, pointRadius: 2, fill: false },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        scales: {
          y: {
            min: 0,
            max: 2.2,
            ticks: {
              stepSize: 1,
              color: '#8b949e',
              callback: (v) => ['Low', 'Med', 'High'][Math.round(Number(v))] ?? '',
            },
            grid: { color: 'rgba(255,255,255,0.06)' },
          },
          x: { display: false },
        },
        plugins: {
          legend: { position: 'bottom', labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 12 } },
          tooltip: {
            callbacks: {
              label: (c) => {
                const v = c.raw as number;
                return `${c.dataset.label}: ${['Low', 'Medium', 'High'][Math.round(v)] ?? v}`;
              },
            },
          },
        },
      },
    });
  }

  setConnectionState(connected: boolean, bridgeReachable: boolean): void {
    const badge = byId('badge-connection');
    const text = byId('badge-connection-text');
    badge.classList.toggle('connected', connected);
    text.textContent = connected
      ? 'ESP32 CONNECTED'
      : bridgeReachable
        ? 'WAITING FOR ESP32'
        : 'SERVER UNREACHABLE';
  }

  setModeBadge(source: BridgeState['source']): void {
    const badge = byId('badge-mode');
    if (source === 'simulator') {
      badge.textContent = 'SIMULATION MODE';
      badge.classList.remove('live');
    } else if (source === 'device') {
      badge.textContent = 'LIVE HARDWARE';
      badge.classList.add('live');
    } else {
      badge.textContent = 'NO SIGNAL';
      badge.classList.remove('live');
    }
  }

  apply(payload: DashboardPayload): void {
    const { state, metrics, bridgeReachable } = payload;
    this.setConnectionState(state.connected, bridgeReachable);
    this.setModeBadge(state.source);

    const banner = byId('emergency-banner');
    if (state.emergency && state.emergency_lane) {
      banner.style.display = 'block';
      byId('emg-lane').textContent = state.emergency_lane;
    } else {
      banner.style.display = 'none';
    }

    LANES.forEach((lane) => this.applyLaneData(lane, state.lanes[lane], state.emergency_lane));
    this.updateOverlays(state.lanes);
    this.updatePhasePanel(state, metrics);
    this.updateDecisionStatus(state);
    this.updateTimeline(state);
    this.updateEvents(state.events);
    this.updateChart();
  }

  private updateHeaderClock(): void {
    const now = new Date();
    byId('header-time').textContent = now.toLocaleTimeString('en-GB', { hour12: false });
    byId('header-date').textContent = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  private applyLaneData(lane: Lane, data: BridgeState['lanes'][Lane], emergencyLane: Lane | null): void {
    const level = data.congestion_level ?? 0;
    const label = data.congestion_label ?? 'Low';
    const vc = data.vehicle_count ?? 0;
    const wait = typeof data.avg_wait_time === 'number' ? data.avg_wait_time.toFixed(1) : '—';

    const row = byId(`sidebar-${lane}`);
    row.classList.toggle('emergency', lane === emergencyLane);
    byId(`sidebar-count-${lane}`).textContent = String(vc).padStart(2, '0');
    byId(`sidebar-meta-${lane}`).textContent = `Wait ${wait}s · ${label}`;

    const bars = document.querySelectorAll(`#bars-${lane} span`);
    bars.forEach((bar, i) => {
      bar.classList.toggle('on', i <= level);
      (bar as HTMLElement).style.height = `${6 + i * 4}px`;
    });

    this.history[lane].push(level);
    if (this.history[lane].length > MAX_HISTORY) this.history[lane].shift();
  }

  private updateOverlays(lanes: BridgeState['lanes']): void {
    LANES.forEach((lane) => {
      const data = lanes[lane];
      const vc = data.vehicle_count ?? 0;
      byId(`overlay-vc-${lane}`).textContent = `${String(vc).padStart(2, '0')} vehicle${vc === 1 ? '' : 's'}`;
      const sigEl = byId(`overlay-sig-${lane}`);
      sigEl.textContent = data.signal;
      sigEl.className = 'arm-signal ' + (data.signal === 'GREEN' ? 'sig-green' : 'sig-red');
    });
  }

  private syncCountdown(phase: PhaseInfo, lanes: BridgeState['lanes']): void {
    const key = phase.type + '|' + phase.activeLanes.join(',');
    const gt = maxGreenAmong(lanes, phase.activeLanes.length ? phase.activeLanes : PHASE_H);
    if (key !== this.lastPhaseKey || gt !== this.lastGreenTime) {
      this.lastPhaseKey = key;
      this.lastGreenTime = gt;
      this.phaseDurationSec = gt;
      this.phaseEndAt = Date.now() + gt * 1000;
    }
    if (phase.type === 'horizontal') this.lastGreenH = gt;
    if (phase.type === 'vertical') this.lastGreenV = gt;
  }

  private tickCountdown(): void {
    const remain = Math.max(0, Math.ceil((this.phaseEndAt - Date.now()) / 1000));
    byId('countdown-sec').innerHTML = `${remain}<small>sec</small>`;
    const circ = 2 * Math.PI * 42;
    const pct = this.phaseDurationSec > 0 ? remain / this.phaseDurationSec : 0;
    byId('countdown-arc').setAttribute('stroke-dashoffset', String(circ * (1 - pct)));
  }

  private updatePhasePanel(state: BridgeState, metrics: { avg_wait_time: number }): void {
    const lanes = state.lanes;
    const phase = derivePhase(lanes, state.emergency, state.emergency_lane);
    this.syncCountdown(phase, lanes);
    this.tickCountdown();

    byId('phase-num').textContent =
      phase.type === 'horizontal' ? 'Phase 1 of 2' :
      phase.type === 'vertical' ? 'Phase 2 of 2' :
      phase.type === 'emergency' ? 'Emergency' : 'Phase — of 2';
    byId('phase-name').textContent = phase.label;
    byId('next-phase-text').textContent = phase.nextLabel;

    byId('sum-total').textContent = String(state.total_vehicles ?? '—');
    byId('sum-cycles').textContent = String(state.cycle_count ?? '—');
    byId('sum-wait').textContent = metrics.avg_wait_time != null ? `${metrics.avg_wait_time}s` : '—';
    byId('sum-incidents').textContent = state.emergency ? '1 (active)' : '0';
  }

  private updateDecisionStatus(state: BridgeState): void {
    const lanes = state.lanes;
    const latestDecision = state.events.find((e) => e.category === 'decision' || !e.category);
    byId('ai-decision-msg').textContent = latestDecision?.msg ?? 'Waiting for first decision…';

    let peak: Lane = 'A';
    LANES.forEach((l) => {
      if (lanes[l].congestion_level >= lanes[peak].congestion_level) peak = l;
    });
    byId('qm-confidence').textContent = `${Math.round((lanes[peak].confidence ?? 0) * 100)}%`;

    // Only recompute on an actual change in the vehicle counter — most WS
    // ticks land between sensor packets with zero delta, and dividing by
    // the resulting sub-second dt would make this number spike wildly.
    const now = Date.now();
    if (this.lastTotalVehicles != null) {
      const dv = state.total_vehicles - this.lastTotalVehicles;
      if (dv > 0) {
        const dt = (now - this.lastVehiclesAt) / 1000;
        const perMin = dt > 0 ? Math.max(0, Math.round((dv / dt) * 60)) : 0;
        byId('qm-throughput').textContent = String(perMin);
        this.lastVehiclesAt = now;
      }
    } else {
      this.lastVehiclesAt = now;
    }
    this.lastTotalVehicles = state.total_vehicles;

    byId('qm-emergency').textContent = state.emergency ? 'YES' : 'NO';
  }

  private updateTimeline(state: BridgeState): void {
    const lanes = state.lanes;
    const phase = derivePhase(lanes, state.emergency, state.emergency_lane);
    const tlH = byId('tl-h');
    const tlV = byId('tl-v');

    const gh = maxGreenAmong(lanes, PHASE_H);
    const gv = maxGreenAmong(lanes, PHASE_V);
    if (phase.type === 'horizontal') this.lastGreenH = gh;
    if (phase.type === 'vertical') this.lastGreenV = gv;

    tlH.style.flex = String(this.lastGreenH);
    tlV.style.flex = String(this.lastGreenV);
    const horizActive = phase.type === 'horizontal';
    const vertActive = phase.type === 'vertical';
    tlH.classList.toggle('inactive', vertActive);
    tlV.classList.toggle('inactive', horizActive);
    tlH.classList.remove('seg-green', 'seg-red');
    tlV.classList.remove('seg-green', 'seg-red');
    tlH.classList.add(horizActive ? 'seg-green' : 'seg-red');
    tlV.classList.add(vertActive ? 'seg-green' : 'seg-red');

    tlH.textContent = horizActive ? `West & East GREEN ${this.lastGreenH}s` : 'West & East RED';
    tlV.textContent = vertActive ? `North & South GREEN ${this.lastGreenV}s` : 'North & South RED';

    const cycle = this.lastGreenH + this.lastGreenV + AMBER_TIME_VIS * 2;
    byId('cycle-time').textContent = `${cycle}s (est.)`;
  }

  private updateEvents(events: BridgeState['events']): void {
    const log = byId('event-log');
    if (!events || events.length === 0) return;
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

  private updateChart(): void {
    LANES.forEach((lane, i) => {
      this.chart.data.datasets[i].data = [...this.history[lane]];
    });
    const len = Math.max(...LANES.map((l) => this.history[l].length), 1);
    this.chart.data.labels = Array(len).fill('');
    this.chart.update('none');
  }
}
