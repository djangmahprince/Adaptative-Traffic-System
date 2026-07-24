export type Lane = 'A' | 'B' | 'C' | 'D';
export type Signal = 'GREEN' | 'RED';
export type Source = 'simulator' | 'device' | null;

export interface LaneState {
  vehicle_count: number;
  avg_wait_time: number;
  sensor_activation: number;
  congestion_level: number;
  congestion_label: string;
  confidence: number;
  green_time: number;
  signal: Signal;
}

export interface EventEntry {
  time: string;
  msg: string;
  category?: 'decision' | 'emergency' | 'override' | 'connection';
}

export interface ManualOverride {
  type: 'emergency' | 'congestion';
  lane: Lane;
  level: number | null;
  set_at: number;
}

/** Raw shape returned by the Python state bridge (server/server.py). */
export interface BridgeState {
  lanes: Record<Lane, LaneState>;
  current_phase: number;
  phase_green_time: number;
  emergency: boolean;
  emergency_lane: Lane | null;
  manual_override: ManualOverride | null;
  cycle_count: number;
  total_vehicles: number;
  connected: boolean;
  source: Source;
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

export interface CycleRow {
  id: number;
  ts: string;
  epoch: number;
  phase: number;
  emergency: number;
  emergency_lane: Lane | null;
  total_vehicles: number;
  cycle_count: number;
  latency_ms: number;
  a_count: number; a_wait: number; a_level: number; a_confidence: number; a_signal: Signal;
  b_count: number; b_wait: number; b_level: number; b_confidence: number; b_signal: Signal;
  c_count: number; c_wait: number; c_level: number; c_confidence: number; c_signal: Signal;
  d_count: number; d_wait: number; d_level: number; d_confidence: number; d_signal: Signal;
}

export interface NetworkStats {
  connected: boolean;
  source: Source;
  last_update: string | null;
  history: { time: string; epoch: number; msg: string }[];
  connect_count: number;
  disconnect_count: number;
}

export interface ReportSummary {
  range: string;
  cycles: number;
  vehicles: number;
  incidents: number;
  busiest_lane: Lane | null;
  lanes: Record<Lane, { avg_wait: number; avg_count: number }>;
  avg_latency_ms: number;
}

export interface ModelMetrics {
  accuracy: number;
  precision_weighted: number;
  recall_weighted: number;
  f1_weighted: number;
  cv_mean: number;
  cv_std: number;
  cv_folds: number;
  n_estimators: number;
  criterion: string;
  train_samples: number;
  test_samples: number;
  confusion_matrix: number[][];
  feature_importances: Record<string, number>;
}

export const LANES: Lane[] = ['A', 'B', 'C', 'D'];
export const LANE_LABEL: Record<Lane, string> = { A: 'West', B: 'North', C: 'East', D: 'South' };
