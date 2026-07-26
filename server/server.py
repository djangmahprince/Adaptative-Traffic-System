# ============================================================
#  AI Traffic Control System
#  File: server/server.py
#
#  REALISTIC SIGNAL LOGIC:
#  A real four-way intersection runs in two phases:
#
#  Phase 1 (Horizontal): Lane A (West) + Lane C (East) GREEN
#                        Lane B (North) + Lane D (South) RED
#
#  Phase 2 (Vertical):   Lane B (North) + Lane D (South) GREEN
#                        Lane A (West)  + Lane C (East)  RED
#
#  Green duration per phase = MAX congestion level of the
#  two active lanes, so the busier road gets enough time.
#  Amber = 3 seconds between every phase transition.
#
#  Emergency override: all RED except emergency lane GREEN,
#  triggered either by the RC522 RFID reader on Lane A (real
#  hardware) or by a manual dashboard override (for demos).
#
#  This module runs in the same process as the Flask dashboard
#  (see dashboard/app.py) — Flask imports it directly and reads
#  shared_state / calls its functions in-process. There is no
#  separate bridge server; that's only needed when the web layer
#  runs in a different process/language than the ML+TCP server.
# ============================================================

import socket
import json
import joblib
import numpy as np
import threading
import time
import os
import logging
from datetime import datetime

import history

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
ML_DIR      = os.path.join(BASE_DIR, '..', 'ml')
MODEL_PATH  = os.path.join(ML_DIR, 'traffic_model.pkl')
METRICS_PATH = os.path.join(ML_DIR, 'model_metrics.json')

HOST = '0.0.0.0'
PORT = 5050

# Green time per congestion level (seconds)
GREEN_TIME = {0: 10, 1: 20, 2: 35}
AMBER_TIME = 3
LABEL_NAME = {0: 'Low', 1: 'Medium', 2: 'High'}
LANES      = ['A', 'B', 'C', 'D']

# Signal phases — pairs of lanes that move together
# Phase 0: Horizontal roads (A=West, C=East)
# Phase 1: Vertical roads   (B=North, D=South)
PHASES = [
    ['A', 'C'],   # Phase 0 — horizontal
    ['B', 'D'],   # Phase 1 — vertical
]

EMERGENCY_HOLD_SECS      = 15
EMERGENCY_COOLDOWN_SECS  = 30

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('TrafficServer')

# ── Shared state (read by the Node/TS dashboard) ──────────────
shared_state = {
    'lanes': {
        lane: {
            'vehicle_count':     0,
            'avg_wait_time':     0,
            'sensor_activation': 0,
            'congestion_level':  0,
            'congestion_label':  'Low',
            'confidence':        0,
            'green_time':        GREEN_TIME[0],
            'signal':            'RED',
        }
        for lane in LANES
    },
    'current_phase':    0,       # 0 = A+C green, 1 = B+D green
    'phase_green_time': 10,      # seconds for current phase
    'emergency':        False,
    'emergency_lane':   None,
    'last_emergency':   0,
    'manual_override':  None,    # {'type': 'emergency'|'congestion', 'lane', 'level', 'set_at'}
    'cycle_count':      0,
    'total_vehicles':   0,
    'events':           [],
    'connected':        False,
    'source':           None,    # 'simulator' | 'device', from the last packet
    'last_update':      None,
}
state_lock = threading.Lock()

# Set once at startup / on each packet so a manual override can be applied
# immediately without waiting for the next sensor reading.
_model = None
_last_packet = None


def load_model():
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(
            f"Model not found: {MODEL_PATH}\n"
            "Run ml/generate_dataset.py then ml/train_model.py first."
        )
    model = joblib.load(MODEL_PATH)
    log.info(f"Model loaded: {MODEL_PATH}")
    return model


def predict_congestion(model, vehicle_count, avg_wait_time, sensor_activation):
    features = np.array([[vehicle_count, avg_wait_time, sensor_activation]])
    proba = model.predict_proba(features)[0]
    pred = int(np.argmax(proba))
    confidence = float(proba[pred])
    return pred, LABEL_NAME[pred], confidence


def add_event(message, category='decision'):
    ts = history.record_event(message, category=category)
    with state_lock:
        shared_state['events'].insert(0, {'time': ts, 'msg': message, 'category': category})
        shared_state['events'] = shared_state['events'][:50]


def apply_manual_override(action, lane=None, level=None):
    """Called from the dashboard's POST /api/override. Applies immediately
    against the last known sensor reading so the effect is visible without
    waiting for the next packet."""
    if action == 'reset':
        with state_lock:
            shared_state['manual_override'] = None
        add_event('Manual override cleared — AI resumed normal control', category='override')
    elif action == 'emergency':
        with state_lock:
            shared_state['manual_override'] = {
                'type': 'emergency', 'lane': lane, 'level': None, 'set_at': time.time(),
            }
        add_event(f'Manual override — emergency priority forced for Lane {lane}', category='override')
    elif action == 'congestion':
        with state_lock:
            shared_state['manual_override'] = {
                'type': 'congestion', 'lane': lane, 'level': level, 'set_at': time.time(),
            }
        add_event(
            f'Manual override — forced {LABEL_NAME[level]} congestion on Lane {lane}',
            category='override',
        )
    else:
        return False

    if _model is not None and _last_packet is not None:
        compute_timing(_model, _last_packet, record=False)
    return True


def compute_timing(model, packet, record=True):
    """
    Compute per-lane congestion predictions and determine
    which phase runs next and for how long.

    Phase selection rotates A+C → B+D → A+C → ...
    Green duration = GREEN_TIME of the HIGHEST congestion
    lane in the active phase (so busier road gets more time).

    `record` is False when this is an immediate refresh triggered by a
    manual override rather than a genuine new sensor reading — in that
    case cycle/vehicle counters and history rows are not touched.
    """
    now = time.time()
    emergency_active = False
    emergency_lane   = None

    with state_lock:
        override = shared_state.get('manual_override')

    # ── Manual emergency override expiry ──────────────────────
    if override and override['type'] == 'emergency' and now - override['set_at'] > EMERGENCY_HOLD_SECS:
        with state_lock:
            shared_state['manual_override'] = None
        add_event(
            f"Emergency cleared — Lane {override['lane']} resuming normal AI control",
            category='emergency',
        )
        override = None

    # ── Determine emergency state (manual override takes priority) ────
    if override and override['type'] == 'emergency':
        emergency_active = True
        emergency_lane   = override['lane']
        with state_lock:
            shared_state['emergency']      = True
            shared_state['emergency_lane'] = emergency_lane
    elif packet.get('emergency', 0) not in [0, '0', '']:
        last_emg = shared_state.get('last_emergency', 0)
        if now - last_emg >= EMERGENCY_COOLDOWN_SECS:
            emergency_active = True
            emergency_lane   = 'A'
            log.warning("EMERGENCY OVERRIDE — Lane A priority")
            add_event(
                f"RFID tag detected — emergency priority active for "
                f"Lane A ({EMERGENCY_HOLD_SECS}s)",
                category='emergency',
            )
            with state_lock:
                shared_state['last_emergency'] = now
                shared_state['emergency']       = True
                shared_state['emergency_lane']  = emergency_lane

    # ── Predict congestion for every lane ─────────────────────
    lane_levels = {}
    for lane in LANES:
        vc = float(packet.get(f'lane{lane}_count', 0))
        wt = float(packet.get(f'lane{lane}_wait',  0))
        sa = float(packet.get(f'lane{lane}_activation', vc * 0.5))

        if override and override['type'] == 'congestion' and override['lane'] == lane:
            level, label, confidence = override['level'], LABEL_NAME[override['level']], 1.0
        else:
            level, label, confidence = predict_congestion(model, vc, wt, sa)

        lane_levels[lane] = {
            'level': level, 'label': label, 'vc': vc, 'wt': wt, 'sa': sa, 'confidence': confidence,
        }

    # ── Determine next phase ──────────────────────────────────
    with state_lock:
        current_phase = shared_state['current_phase']
    next_phase = (current_phase + 1) % 2
    active_lanes = PHASES[next_phase]

    # Green duration = highest congestion in the active pair
    max_level = max(lane_levels[l]['level'] for l in active_lanes)
    phase_green = GREEN_TIME[max_level]

    # ── Build per-lane signal states ──────────────────────────
    timing = {}
    for lane in LANES:
        info = lane_levels[lane]

        if emergency_active:
            signal     = 'GREEN' if lane == emergency_lane else 'RED'
            green_time = EMERGENCY_HOLD_SECS if lane == emergency_lane else 0
        else:
            # Only lanes in the active phase get GREEN
            signal     = 'GREEN' if lane in active_lanes else 'RED'
            green_time = phase_green if lane in active_lanes else 0

        timing[lane] = {
            'green_time':        green_time,
            'amber_time':        AMBER_TIME,
            'congestion_level':  info['level'],
            'congestion_label':  info['label'],
            'signal':            signal,
            'emergency_override': emergency_active and lane == emergency_lane,
        }

        # Update shared state for dashboard
        with state_lock:
            shared_state['lanes'][lane].update({
                'vehicle_count':     int(info['vc']),
                'avg_wait_time':     round(info['wt'], 1),
                'sensor_activation': round(info['sa'], 2),
                'congestion_level':  info['level'],
                'congestion_label':  info['label'],
                'confidence':        round(info['confidence'], 3),
                'green_time':        green_time,
                'signal':            signal,
            })

    # ── Clear emergency after one cycle (unless still overridden) ─────
    if not emergency_active:
        with state_lock:
            shared_state['emergency']      = False
            shared_state['emergency_lane'] = None

    # ── Update global counters ────────────────────────────────
    with state_lock:
        shared_state['current_phase']    = next_phase
        shared_state['phase_green_time'] = phase_green
        if record:
            shared_state['cycle_count']    += 1
            shared_state['total_vehicles'] += sum(
                int(packet.get(f'lane{l}_count', 0)) for l in LANES
            )
        shared_state['source']      = packet.get('source', 'device')
        shared_state['last_update'] = datetime.now().strftime('%H:%M:%S')
        cycle_count    = shared_state['cycle_count']
        total_vehicles = shared_state['total_vehicles']

    # Stop the clock here — everything after this is logging/persistence,
    # not part of the prediction + phase-decision work being measured.
    latency_ms = round((time.time() - now) * 1000, 2)

    phase_name = "A+C (Horizontal)" if next_phase == 0 else "B+D (Vertical)"
    log.info(
        f"Phase {next_phase} [{phase_name}] — "
        f"Green {phase_green}s | "
        f"A:{lane_levels['A']['label']} "
        f"B:{lane_levels['B']['label']} "
        f"C:{lane_levels['C']['label']} "
        f"D:{lane_levels['D']['label']}"
    )

    if record:
        controlling_lane = max(active_lanes, key=lambda l: lane_levels[l]['level'])
        conf_pct = round(lane_levels[controlling_lane]['confidence'] * 100)
        add_event(
            f"Lane {controlling_lane} given {phase_green}s green — "
            f"{lane_levels[controlling_lane]['label']} congestion (confidence {conf_pct}%)"
        )
        history.record_cycle({
            'phase': next_phase,
            'emergency': emergency_active,
            'emergency_lane': emergency_lane,
            'total_vehicles': total_vehicles,
            'cycle_count': cycle_count,
            'latency_ms': latency_ms,
            **{
                lane: (
                    int(lane_levels[lane]['vc']), round(lane_levels[lane]['wt'], 1),
                    lane_levels[lane]['level'], round(lane_levels[lane]['confidence'], 3),
                    timing[lane]['signal'],
                )
                for lane in LANES
            },
        })

    return timing


def handle_client(conn, addr, model):
    global _last_packet
    log.info(f"ESP32 connected from {addr}")
    add_event(f"ESP32 connected from {addr[0]}", category='connection')
    with state_lock:
        shared_state['connected'] = True
    buffer = ''
    try:
        while True:
            data = conn.recv(1024).decode('utf-8', errors='ignore')
            if not data:
                break
            buffer += data
            while '\n' in buffer:
                line, buffer = buffer.split('\n', 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    packet = json.loads(line)
                except json.JSONDecodeError as e:
                    log.warning(f"Bad JSON: {e}")
                    continue

                _last_packet = packet
                timing = compute_timing(model, packet)

                response = {
                    'laneA_green':     timing['A']['green_time'],
                    'laneB_green':     timing['B']['green_time'],
                    'laneC_green':     timing['C']['green_time'],
                    'laneD_green':     timing['D']['green_time'],
                    'laneA_signal':    timing['A']['signal'],
                    'laneB_signal':    timing['B']['signal'],
                    'laneC_signal':    timing['C']['signal'],
                    'laneD_signal':    timing['D']['signal'],
                    'amber_time':      AMBER_TIME,
                    'active_phase':    shared_state['current_phase'],
                    'emergency_active': any(
                        timing[l].get('emergency_override', False) for l in LANES
                    ),
                    'emergency_lane':  shared_state.get('emergency_lane'),
                }
                conn.sendall((json.dumps(response) + '\n').encode('utf-8'))

    except ConnectionResetError:
        log.warning("ESP32 disconnected abruptly")
    except Exception as e:
        log.error(f"Client error: {e}")
    finally:
        conn.close()
        with state_lock:
            shared_state['connected'] = False
        log.info(f"Connection from {addr} closed")
        add_event(f"ESP32 disconnected from {addr[0]}", category='connection')


def start_tcp_server(model):
    global _model
    _model = model
    server_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_sock.bind((HOST, PORT))
    server_sock.listen(1)
    log.info("=" * 52)
    log.info("  TCP Server listening on port 5050")
    log.info("  Waiting for ESP32...")
    log.info("=" * 52)
    while True:
        try:
            conn, addr = server_sock.accept()
            t = threading.Thread(
                target=handle_client, args=(conn, addr, model), daemon=True
            )
            t.start()
        except KeyboardInterrupt:
            break
        except Exception as e:
            log.error(f"Accept error: {e}")
    server_sock.close()


# ── In-process accessors for the Flask dashboard ──────────────
# These replace what used to be an HTTP bridge — Flask calls them as plain
# function calls in the same interpreter, no network hop involved.

def get_state_snapshot():
    with state_lock:
        return {
            'lanes': {k: dict(v) for k, v in shared_state['lanes'].items()},
            'current_phase':    shared_state['current_phase'],
            'phase_green_time': shared_state['phase_green_time'],
            'emergency':        shared_state['emergency'],
            'emergency_lane':   shared_state['emergency_lane'],
            'manual_override':  shared_state['manual_override'],
            'cycle_count':      shared_state['cycle_count'],
            'total_vehicles':   shared_state['total_vehicles'],
            'connected':        shared_state['connected'],
            'source':           shared_state['source'],
            'last_update':      shared_state['last_update'],
            'events':           shared_state['events'][:10],
        }


def get_metrics():
    state = get_state_snapshot()
    waits = [state['lanes'][l]['avg_wait_time'] for l in LANES]
    avg_wait_time = round(sum(waits) / len(waits), 1) if waits else 0
    return {
        'total_vehicles': state['total_vehicles'],
        'cycle_count':    state['cycle_count'],
        'avg_wait_time':  avg_wait_time,
    }


def get_network_snapshot():
    state = get_state_snapshot()
    return {
        'connected':   state['connected'],
        'source':      state['source'],
        'last_update': state['last_update'],
        **history.get_network_stats(),
    }


def get_model_metrics():
    with open(METRICS_PATH) as f:
        return json.load(f)


def init_app():
    """Called once by dashboard/app.py before starting Flask, and by the
    TCP-server thread's own startup — safe to call twice (idempotent)."""
    history.init_db()


if __name__ == '__main__':
    model = load_model()
    init_app()
    start_tcp_server(model)
