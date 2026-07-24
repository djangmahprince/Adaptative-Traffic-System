import { EventEmitter } from 'node:events';
import { LANES, type BridgeState, type DashboardPayload, type Metrics } from '../shared/types.js';
import { PYTHON_BRIDGE_BASE } from './config.js';

const BRIDGE_URL = `${PYTHON_BRIDGE_BASE}/api/state`;
const POLL_MS = 500;

function emptyLane() {
  return {
    vehicle_count: 0, avg_wait_time: 0, sensor_activation: 0, congestion_level: 0,
    congestion_label: 'Low', confidence: 0, green_time: 0, signal: 'RED' as const,
  };
}

function emptyState(): BridgeState {
  return {
    lanes: { A: emptyLane(), B: emptyLane(), C: emptyLane(), D: emptyLane() },
    current_phase: 0,
    phase_green_time: 10,
    emergency: false,
    emergency_lane: null,
    manual_override: null,
    cycle_count: 0,
    total_vehicles: 0,
    connected: false,
    source: null,
    last_update: null,
    events: [],
  };
}

function computeMetrics(state: BridgeState): Metrics {
  const waits = LANES.map((l) => state.lanes[l].avg_wait_time);
  const avg_wait_time = waits.length ? Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10 : 0;
  return {
    total_vehicles: state.total_vehicles,
    cycle_count: state.cycle_count,
    avg_wait_time,
  };
}

/**
 * Polls the Python TCP server's internal state bridge and re-emits the
 * latest dashboard payload. Node never talks TCP to the ESP32/simulator
 * directly — the Python process owns that protocol and the ML model.
 */
export class PythonBridge extends EventEmitter {
  private latest: DashboardPayload;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.latest = { state: emptyState(), metrics: computeMetrics(emptyState()), bridgeReachable: false };
  }

  get current(): DashboardPayload {
    return this.latest;
  }

  start(): void {
    if (this.timer) return;
    const poll = async () => {
      try {
        const res = await fetch(BRIDGE_URL, { signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`bridge responded ${res.status}`);
        const state = (await res.json()) as BridgeState;
        this.latest = { state, metrics: computeMetrics(state), bridgeReachable: true };
      } catch {
        // Python side isn't up yet (or dropped) — keep serving the last
        // known lanes but mark the bridge unreachable so the UI can show it.
        this.latest = { ...this.latest, bridgeReachable: false };
      }
      this.emit('update', this.latest);
    };
    this.timer = setInterval(poll, POLL_MS);
    void poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
