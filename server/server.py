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
#  Emergency override: all RED except emergency lane GREEN.
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
ML_DIR     = os.path.join(BASE_DIR, '..', 'ml')
MODEL_PATH = os.path.join(ML_DIR, 'traffic_model.pkl')

HOST = '0.0.0.0'
PORT = 5050

# Internal state bridge — read-only JSON feed consumed by the Node/TS
# dashboard (dashboard/). Bound to localhost only; it is not the public
# web server.
BRIDGE_HOST = '127.0.0.1'
BRIDGE_PORT = 5051

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

# ── Shared state (read by Flask dashboard) ────────────────────
shared_state = {
    'lanes': {
        lane: {
            'vehicle_count':     0,
            'avg_wait_time':     0,
            'sensor_activation': 0,
            'congestion_level':  0,
            'congestion_label':  'Low',
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
    'cycle_count':      0,
    'total_vehicles':   0,
    'events':           [],
    'connected':        False,
    'last_update':      None,
}
state_lock = threading.Lock()


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
    pred = int(model.predict(features)[0])
    return pred, LABEL_NAME[pred]


def add_event(message):
    ts = datetime.now().strftime('%H:%M:%S')
    with state_lock:
        shared_state['events'].insert(0, {'time': ts, 'msg': message})
        shared_state['events'] = shared_state['events'][:50]


def compute_timing(model, packet):
    """
    Compute per-lane congestion predictions and determine
    which phase runs next and for how long.

    Phase selection rotates A+C → B+D → A+C → ...
    Green duration = GREEN_TIME of the HIGHEST congestion
    lane in the active phase (so busier road gets more time).
    """
    now = time.time()
    emergency_active = False
    emergency_lane   = None

    # ── Check emergency ───────────────────────────────────────
    if packet.get('emergency', 0) not in [0, '0', '']:
        last_emg = shared_state.get('last_emergency', 0)
        if now - last_emg >= EMERGENCY_COOLDOWN_SECS:
            emergency_active = True
            emergency_lane   = 'A'
            log.warning("EMERGENCY OVERRIDE — Lane A priority")
            add_event(
                f"Emergency vehicle detected — "
                f"Lane A priority for {EMERGENCY_HOLD_SECS}s"
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
        level, label = predict_congestion(model, vc, wt, sa)
        lane_levels[lane] = (level, label, vc, wt, sa)

    # ── Determine next phase ──────────────────────────────────
    with state_lock:
        current_phase = shared_state['current_phase']
    next_phase = (current_phase + 1) % 2
    active_lanes = PHASES[next_phase]

    # Green duration = highest congestion in the active pair
    max_level = max(lane_levels[l][0] for l in active_lanes)
    phase_green = GREEN_TIME[max_level]

    # ── Build per-lane signal states ──────────────────────────
    timing = {}
    for lane in LANES:
        level, label, vc, wt, sa = lane_levels[lane]

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
            'congestion_level':  level,
            'congestion_label':  label,
            'signal':            signal,
            'emergency_override': emergency_active and lane == emergency_lane,
        }

        # Update shared state for dashboard
        with state_lock:
            shared_state['lanes'][lane].update({
                'vehicle_count':     int(vc),
                'avg_wait_time':     round(wt, 1),
                'sensor_activation': round(sa, 2),
                'congestion_level':  level,
                'congestion_label':  label,
                'green_time':        green_time,
                'signal':            signal,
            })

    # ── Clear emergency after one cycle ───────────────────────
    if not emergency_active:
        with state_lock:
            shared_state['emergency']      = False
            shared_state['emergency_lane'] = None

    # ── Update global counters ────────────────────────────────
    with state_lock:
        shared_state['current_phase']    = next_phase
        shared_state['phase_green_time'] = phase_green
        shared_state['cycle_count']     += 1
        shared_state['total_vehicles']  += sum(
            int(packet.get(f'lane{l}_count', 0)) for l in LANES
        )
        shared_state['last_update'] = datetime.now().strftime('%H:%M:%S')
        shared_state['connected']   = True

    phase_name = "A+C (Horizontal)" if next_phase == 0 else "B+D (Vertical)"
    log.info(
        f"Phase {next_phase} [{phase_name}] — "
        f"Green {phase_green}s | "
        f"A:{lane_levels['A'][1]} "
        f"B:{lane_levels['B'][1]} "
        f"C:{lane_levels['C'][1]} "
        f"D:{lane_levels['D'][1]}"
    )

    return timing


def handle_client(conn, addr, model):
    log.info(f"ESP32 connected from {addr}")
    add_event(f"ESP32 connected from {addr[0]}")
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
        add_event(f"ESP32 disconnected from {addr[0]}")


def start_tcp_server(model):
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


class StateBridgeHandler(BaseHTTPRequestHandler):
    """Serves shared_state as JSON for the Node/TS dashboard to poll."""

    def log_message(self, format, *args):
        pass  # the TCP server's own logging is the source of truth

    def do_GET(self):
        if self.path != '/api/state':
            self.send_response(404)
            self.end_headers()
            return

        with state_lock:
            payload = {
                'lanes': {k: dict(v) for k, v in shared_state['lanes'].items()},
                'current_phase':    shared_state['current_phase'],
                'phase_green_time': shared_state['phase_green_time'],
                'emergency':        shared_state['emergency'],
                'emergency_lane':   shared_state['emergency_lane'],
                'cycle_count':      shared_state['cycle_count'],
                'total_vehicles':   shared_state['total_vehicles'],
                'connected':        shared_state['connected'],
                'last_update':      shared_state['last_update'],
                'events':           shared_state['events'][:10],
            }

        body = json.dumps(payload).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_state_bridge():
    httpd = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), StateBridgeHandler)
    log.info(f"  State bridge     : http://{BRIDGE_HOST}:{BRIDGE_PORT}/api/state (internal)")
    httpd.serve_forever()


if __name__ == '__main__':
    model = load_model()
    threading.Thread(target=start_state_bridge, daemon=True).start()
    start_tcp_server(model)
