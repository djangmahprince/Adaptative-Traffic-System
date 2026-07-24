export type Lane = 'A' | 'B' | 'C' | 'D';
export type Signal = 'GREEN' | 'RED';

export interface LaneState {
  vehicle_count: number;
  avg_wait_time: number;
  sensor_activation: number;
  congestion_level: number;
  congestion_label: string;
  green_time: number;
  signal: Signal;
}

export interface EventEntry {
  time: string;
  msg: string;
}

/** Raw shape returned by the Python state bridge (server/server.py). */
export interface BridgeState {
  lanes: Record<Lane, LaneState>;
  current_phase: number;
  phase_green_time: number;
  emergency: boolean;
  emergency_lane: Lane | null;
  cycle_count: number;
  total_vehicles: number;
  connected: boolean;
  last_update: string | null;
  events: EventEntry[];
}

export interface Metrics {
  total_vehicles: number;
  cycle_count: number;
  avg_wait_time: number;
}

/** Payload broadcast to browser clients over the /ws WebSocket. */
export interface DashboardPayload {
  state: BridgeState;
  metrics: Metrics;
  /** True while the Node server can reach the Python state bridge. */
  bridgeReachable: boolean;
}

export const LANES: Lane[] = ['A', 'B', 'C', 'D'];
