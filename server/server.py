# ============================================================
#  AI Traffic Control System
#  File: server/server.py
#
#  ROLES (per the project's own framing):
#    Random Forest classifier  = the BRAIN   — predicts congestion
#    This module's phase FSM   = the OFFICER — makes safe timing decisions
#    ESP32 / simulator         = the HANDS   — executes what it's told
#
#  SIGNAL LOGIC — a real, time-based traffic signal cycle:
#
#    NS_GREEN --(adaptive 15-60s)--> NS_YELLOW --(3s)--> NS_ALL_RED --(1.5s)-->
#    EW_GREEN --(adaptive 15-60s)--> EW_YELLOW --(3s)--> EW_ALL_RED --(1.5s)-->
#    (back to NS_GREEN, repeat forever)
#
#  The phase SEQUENCE never changes and never depends on how often sensor
#  packets arrive — a background ticker thread advances it purely on
#  elapsed wall-clock time. The Random Forest model does not choose which
#  direction gets green; it only feeds the congestion level that decides
#  HOW LONG each green phase runs (see compute_green_duration).
#
#  Emergency vehicles never cause an instant light change. A request is
#  recorded as "pending" and only actually granted at the next safe
#  boundary (the transition out of an ALL_RED state) — the current green
#  phase always finishes, then yellow, then all-red, THEN the emergency
#  lane gets its own green/yellow/all-red sequence, after which the
#  normal cycle resumes exactly where it left off.
#
#  This module runs in the same process as the Flask dashboard
#  (see dashboard/app.py) — Flask imports it directly and reads
#  shared_state / calls its functions in-process.
# ============================================================

import socket
import json
import joblib
import numpy as np
import threading
import time
import os
import random
import logging
from datetime import datetime

import history

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
ML_DIR      = os.path.join(BASE_DIR, '..', 'ml')
MODEL_PATH  = os.path.join(ML_DIR, 'traffic_model.pkl')
METRICS_PATH = os.path.join(ML_DIR, 'model_metrics.json')

HOST = '0.0.0.0'
PORT = 5050

LANES = ['A', 'B', 'C', 'D']
LABEL_NAME = {0: 'Low', 1: 'Medium', 2: 'High'}

# ── Signal timing constants (traffic-engineering bounds, not tunable per demo) ──
MIN_GREEN       = 15
MAX_GREEN       = 60
YELLOW_TIME     = 3
ALL_RED_TIME    = 1.5

EMERGENCY_HOLD_SECS      = 15   # how long the emergency lane holds green
EMERGENCY_COOLDOWN_SECS  = 30   # minimum gap between RFID-triggered requests

# ── Demo scenarios ─────────────────────────────────────────────
# Same 5 profiles as simulator/esp32_simulator.py's SCENARIOS, ported here
# so they can run in-process (fed through the exact same update_lane_sensors
# path a real packet takes) and be switched between with a dashboard click
# instead of needing a separate terminal running the standalone simulator.
SCENARIO_POLL_INTERVAL = 2.0
SCENARIOS = {
    'morning_rush': {
        'label': 'Morning Rush',
        'description': 'Heavy demand on primary corridors (Lanes A & C)',
        'lanes': {
            'A': {'count': (7, 11), 'wait': (30, 55)},
            'B': {'count': (0,  2), 'wait': (0,   9)},
            'C': {'count': (6, 10), 'wait': (28, 52)},
            'D': {'count': (0,  2), 'wait': (0,   8)},
        },
    },
    'off_peak': {
        'label': 'Off-Peak Hours',
        'description': 'Minimum idle green light allocation',
        'lanes': {
            'A': {'count': (0, 2), 'wait': (0, 9)},
            'B': {'count': (0, 2), 'wait': (0, 8)},
            'C': {'count': (0, 1), 'wait': (0, 5)},
            'D': {'count': (0, 2), 'wait': (0, 7)},
        },
    },
    'evening_rush': {
        'label': 'Evening Rush',
        'description': 'Multi-lane congestion balance (Lanes B & D)',
        'lanes': {
            'A': {'count': (1,  3), 'wait': (3,  14)},
            'B': {'count': (7, 12), 'wait': (30, 58)},
            'C': {'count': (1,  3), 'wait': (3,  12)},
            'D': {'count': (6, 10), 'wait': (26, 50)},
        },
    },
    'emergency': {
        'label': 'Emergency Mode',
        'description': 'Immediate Lane A RFID override',
        'lanes': {
            'A': {'count': (4, 7), 'wait': (15, 30)},
            'B': {'count': (3, 5), 'wait': (12, 25)},
            'C': {'count': (2, 4), 'wait': (8,  18)},
            'D': {'count': (1, 3), 'wait': (4,  14)},
        },
    },
    'mixed': {
        'label': 'Mixed Medium Flow',
        'description': 'Dynamic phase adjustment under balanced load',
        'lanes': {
            'A': {'count': (3, 5), 'wait': (11, 24)},
            'B': {'count': (3, 6), 'wait': (12, 25)},
            'C': {'count': (3, 5), 'wait': (11, 23)},
            'D': {'count': (4, 6), 'wait': (14, 25)},
        },
    },
}
SCENARIO_ORDER = ['morning_rush', 'off_peak', 'evening_rush', 'emergency', 'mixed']

# The phase never varies — only how long each GREEN state lasts.
PHASE_SEQUENCE = ['NS_GREEN', 'NS_YELLOW', 'NS_ALL_RED', 'EW_GREEN', 'EW_YELLOW', 'EW_ALL_RED']
PHASE_LANES = {
    'NS_GREEN': ['B', 'D'],   # North + South
    'EW_GREEN': ['A', 'C'],   # East + West
}
PHASE_SIGNAL_COLORS = {
    'NS_GREEN':   {'B': 'GREEN',  'D': 'GREEN',  'A': 'RED', 'C': 'RED'},
    'NS_YELLOW':  {'B': 'YELLOW', 'D': 'YELLOW', 'A': 'RED', 'C': 'RED'},
    'NS_ALL_RED': {'A': 'RED', 'B': 'RED', 'C': 'RED', 'D': 'RED'},
    'EW_GREEN':   {'A': 'GREEN',  'C': 'GREEN',  'B': 'RED', 'D': 'RED'},
    'EW_YELLOW':  {'A': 'YELLOW', 'C': 'YELLOW', 'B': 'RED', 'D': 'RED'},
    'EW_ALL_RED': {'A': 'RED', 'B': 'RED', 'C': 'RED', 'D': 'RED'},
}
# phase_state -> the 0/1 value history.py's `cycles.phase` column already
# uses (0 = horizontal/EW, 1 = vertical/NS) — kept for the Analytics page.
PHASE_HISTORY_INDEX = {'EW_GREEN': 0, 'NS_GREEN': 1}

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s  %(levelname)-8s  %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('TrafficServer')

# ── Shared state (read by the Flask dashboard) ────────────────
shared_state = {
    'lanes': {
        lane: {
            'vehicle_count':     0,
            'avg_wait_time':     0,
            'sensor_activation': 0,
            'congestion_level':  0,
            'congestion_label':  'Low',
            'confidence':        0,
            'signal':            'RED',
        }
        for lane in LANES
    },
    'phase_state':       'NS_GREEN',
    'phase_index':       0,
    'phase_started_at':  time.time(),
    'phase_duration':    MIN_GREEN,
    'pending_emergency': None,   # {'lane', 'requested_at', 'source'}
    'emergency':         False,
    'emergency_lane':    None,
    'last_emergency':    0,
    'manual_override':   None,   # {'type': 'congestion', 'lane', 'level', 'set_at'}
    'cycle_count':       0,
    'total_vehicles':    0,
    'events':            [],
    'connected':         False,
    'source':            None,   # 'simulator' | 'device', from the last packet
    'last_update':       None,
    'last_inference_latency_ms': 0,
    'active_scenario':   None,   # key into SCENARIOS, or None
    'scenario_cycle':    0,
}
state_lock = threading.Lock()

# Set once at startup / on each packet — lets a manual override apply its
# visible effect immediately without waiting for the next sensor reading.
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


def compute_green_duration(lane_levels, active_lanes):
    """The Random Forest model (the "brain") only supplies congestion level,
    vehicle count and wait time per lane. This function (the "officer") is
    the only place that turns those into a safe, bounded green duration —
    the model never picks which direction moves."""
    max_level = max(lane_levels[l]['congestion_level'] for l in active_lanes)
    max_count = max(lane_levels[l]['vehicle_count'] for l in active_lanes)
    max_wait  = max(lane_levels[l]['avg_wait_time'] for l in active_lanes)

    base = {0: MIN_GREEN, 1: 25, 2: 42}[max_level]
    bonus = min(18, max_count * 1.0 + max_wait * 0.25)
    duration = base + bonus
    return max(MIN_GREEN, min(MAX_GREEN, round(duration)))


# ── Sensor updates (every incoming packet) ────────────────────
# Deliberately separate from phase timing: readings should always be
# fresh, but they must never cause a light to change on their own.

def update_lane_sensors(model, packet):
    with state_lock:
        override = shared_state.get('manual_override')

    t0 = time.time()
    lane_levels = {}
    for lane in LANES:
        vc = float(packet.get(f'lane{lane}_count', 0))
        wt = float(packet.get(f'lane{lane}_wait', 0))
        sa = float(packet.get(f'lane{lane}_activation', vc * 0.5))

        if override and override['type'] == 'congestion' and override['lane'] == lane:
            level, label, confidence = override['level'], LABEL_NAME[override['level']], 1.0
        else:
            level, label, confidence = predict_congestion(model, vc, wt, sa)

        lane_levels[lane] = {'level': level, 'label': label, 'vc': vc, 'wt': wt, 'sa': sa, 'confidence': confidence}

    latency_ms = round((time.time() - t0) * 1000, 3)

    with state_lock:
        for lane in LANES:
            info = lane_levels[lane]
            shared_state['lanes'][lane].update({
                'vehicle_count':     int(info['vc']),
                'avg_wait_time':     round(info['wt'], 1),
                'sensor_activation': round(info['sa'], 2),
                'congestion_level':  info['level'],
                'congestion_label':  info['label'],
                'confidence':        round(info['confidence'], 3),
            })
        shared_state['total_vehicles'] += sum(int(packet.get(f'lane{l}_count', 0)) for l in LANES)
        shared_state['source'] = packet.get('source', 'device')
        shared_state['last_update'] = datetime.now().strftime('%H:%M:%S')
        shared_state['last_inference_latency_ms'] = latency_ms
        shared_state['connected'] = True

    if packet.get('emergency', 0) not in [0, '0', '']:
        request_emergency('A', source='rfid')


# ── Emergency requests — always deferred to a safe boundary ──

def request_emergency(lane, source='manual'):
    now = time.time()
    with state_lock:
        already_queued = shared_state['pending_emergency'] is not None
        already_active = shared_state['phase_state'].startswith('EMG_')
        last_emg = shared_state['last_emergency']

    if already_queued or already_active:
        return False
    if source == 'rfid' and now - last_emg < EMERGENCY_COOLDOWN_SECS:
        return False

    with state_lock:
        shared_state['pending_emergency'] = {'lane': lane, 'requested_at': now, 'source': source}
        shared_state['last_emergency'] = now

    if source == 'rfid':
        msg = (f"RFID tag detected — emergency priority requested for Lane {lane} "
               f"(will activate once the current phase clears safely)")
        add_event(msg, category='emergency')
    else:
        msg = (f"Manual override — emergency priority requested for Lane {lane} "
               f"(will activate once the current phase clears safely)")
        add_event(msg, category='override')
    return True


def apply_manual_override(action, lane=None, level=None):
    """Called from the dashboard's POST /api/override."""
    if action == 'reset':
        with state_lock:
            shared_state['manual_override'] = None
            had_pending = shared_state['pending_emergency'] is not None
            shared_state['pending_emergency'] = None
        add_event('Manual override cleared — AI resumed normal control', category='override')
        if had_pending:
            add_event('Queued emergency request cancelled by Reset', category='override')
        return True

    if action == 'emergency':
        return request_emergency(lane, source='manual')

    if action == 'congestion':
        with state_lock:
            shared_state['manual_override'] = {
                'type': 'congestion', 'lane': lane, 'level': level, 'set_at': time.time(),
            }
        add_event(f'Manual override — forced {LABEL_NAME[level]} congestion on Lane {lane}', category='override')
        # Reflect the forced level immediately rather than waiting for the
        # next packet — this only touches sensor/prediction display, never
        # the signal itself, so it's safe to apply right away.
        if _model is not None and _last_packet is not None:
            update_lane_sensors(_model, _last_packet)
        return True

    return False


# ── Demo scenarios — an in-process stand-in for the standalone simulator,
# so a scenario can be switched with a dashboard click. Generates synthetic
# packets and feeds them through the exact same update_lane_sensors() path
# a real ESP32/simulator packet takes; it never touches the phase FSM
# directly (that's still driven purely by advance_phase_if_due on elapsed
# wall-clock time, same as always). ──────────────────────────────────────

def _make_scenario_packet(profile, timestamp):
    pkt = {'timestamp': timestamp, 'emergency': '0', 'source': 'simulator'}
    for lane in LANES:
        cfg = profile['lanes'][lane]
        count = random.randint(*cfg['count'])
        wait = round(random.uniform(*cfg['wait']), 1)
        sa = round(max(0, count * random.uniform(0.4, 0.9) + random.gauss(0, 0.2)), 2)
        pkt[f'lane{lane}_count'] = count
        pkt[f'lane{lane}_wait'] = wait
        pkt[f'lane{lane}_activation'] = sa
    return pkt


def start_scenario(name):
    if name not in SCENARIOS:
        return False
    with state_lock:
        shared_state['active_scenario'] = name
        shared_state['scenario_cycle'] = 0
    label = SCENARIOS[name]['label']
    add_event(f'Scenario started — {label} ({SCENARIOS[name]["description"]})', category='override')
    if name == 'emergency':
        # "Immediate Lane A RFID override" — fires the moment this scenario
        # is selected rather than waiting for a tick, same as a real RFID
        # tag being scanned. Uses the manual source so it isn't throttled
        # by the cooldown meant for repeated physical RFID reads.
        request_emergency('A', source='manual')
    return True


def stop_scenario():
    with state_lock:
        was_active = shared_state['active_scenario'] is not None
        shared_state['active_scenario'] = None
        shared_state['connected'] = False
    if was_active:
        add_event('Scenario stopped — no live feed', category='override')
    return True


def _scenario_ticker():
    while True:
        time.sleep(SCENARIO_POLL_INTERVAL)
        try:
            with state_lock:
                name = shared_state['active_scenario']
            if not name:
                continue
            profile = SCENARIOS[name]
            pkt = _make_scenario_packet(profile, int(time.time()))
            global _last_packet
            _last_packet = pkt
            if _model is not None:
                update_lane_sensors(_model, pkt)
            with state_lock:
                shared_state['scenario_cycle'] += 1
        except Exception as e:
            log.error(f"Scenario ticker error: {e}")


# ── Phase state machine — the only thing that ever changes a light ───

def _lane_snapshot():
    with state_lock:
        return {l: dict(shared_state['lanes'][l]) for l in LANES}


def _set_signal_colors(colors):
    """Caller must hold state_lock."""
    for lane in LANES:
        shared_state['lanes'][lane]['signal'] = colors.get(lane, 'RED')


def _log_green_start(state_name, duration, lane_levels):
    active = PHASE_LANES[state_name]
    controlling_lane = max(active, key=lambda l: lane_levels[l]['congestion_level'])
    conf_pct = round(lane_levels[controlling_lane]['confidence'] * 100)
    label = lane_levels[controlling_lane]['congestion_label']
    phase_desc = 'North-South' if state_name == 'NS_GREEN' else 'East-West'
    add_event(
        f"{phase_desc} given {duration}s green — Lane {controlling_lane} "
        f"{label} congestion (confidence {conf_pct}%)"
    )

    with state_lock:
        shared_state['cycle_count'] += 1
        cycle_count = shared_state['cycle_count']
        total_vehicles = shared_state['total_vehicles']
        latency_ms = shared_state['last_inference_latency_ms']
        current_signals = {l: shared_state['lanes'][l]['signal'] for l in LANES}

    history.record_cycle({
        'phase': PHASE_HISTORY_INDEX[state_name],
        'emergency': False,
        'emergency_lane': None,
        'total_vehicles': total_vehicles,
        'cycle_count': cycle_count,
        'latency_ms': latency_ms,
        **{
            lane: (
                lane_levels[lane]['vehicle_count'], lane_levels[lane]['avg_wait_time'],
                lane_levels[lane]['congestion_level'], lane_levels[lane]['confidence'],
                current_signals[lane],
            )
            for lane in LANES
        },
    })


def _enter_state(idx, state_name, now, lane_levels):
    if state_name.endswith('GREEN'):
        duration = compute_green_duration(lane_levels, PHASE_LANES[state_name])
    elif state_name.endswith('YELLOW'):
        duration = YELLOW_TIME
    else:  # ALL_RED
        duration = ALL_RED_TIME

    with state_lock:
        shared_state['phase_index'] = idx
        shared_state['phase_state'] = state_name
        shared_state['phase_started_at'] = now
        shared_state['phase_duration'] = duration
        _set_signal_colors(PHASE_SIGNAL_COLORS[state_name])

    phase_name = "EW (Horizontal)" if state_name.startswith('EW') else "NS (Vertical)"
    log.info(f"-> {state_name} [{phase_name}] for {duration}s")

    if state_name.endswith('GREEN'):
        _log_green_start(state_name, duration, lane_levels)


def _enter_emergency_green(pending, now):
    lane = pending['lane']
    with state_lock:
        shared_state['pending_emergency'] = None
        shared_state['emergency'] = True
        shared_state['emergency_lane'] = lane
        shared_state['phase_state'] = 'EMG_GREEN'
        shared_state['phase_started_at'] = now
        shared_state['phase_duration'] = EMERGENCY_HOLD_SECS
        colors = {l: ('GREEN' if l == lane else 'RED') for l in LANES}
        _set_signal_colors(colors)
    log.warning(f"-> EMG_GREEN — Lane {lane} priority for {EMERGENCY_HOLD_SECS}s")
    add_event(f"Emergency priority active — Lane {lane} green for {EMERGENCY_HOLD_SECS}s", category='emergency')


def _advance_emergency_fsm(state_name, now):
    with state_lock:
        emg_lane = shared_state['emergency_lane']

    if state_name == 'EMG_GREEN':
        with state_lock:
            shared_state['phase_state'] = 'EMG_YELLOW'
            shared_state['phase_started_at'] = now
            shared_state['phase_duration'] = YELLOW_TIME
            colors = {l: ('YELLOW' if l == emg_lane else 'RED') for l in LANES}
            _set_signal_colors(colors)
    elif state_name == 'EMG_YELLOW':
        with state_lock:
            shared_state['phase_state'] = 'EMG_ALL_RED'
            shared_state['phase_started_at'] = now
            shared_state['phase_duration'] = ALL_RED_TIME
            _set_signal_colors({l: 'RED' for l in LANES})
    elif state_name == 'EMG_ALL_RED':
        with state_lock:
            shared_state['emergency'] = False
            shared_state['emergency_lane'] = None
            idx = shared_state['phase_index']
        add_event(f"Emergency cleared — Lane {emg_lane} resuming normal AI control", category='emergency')
        next_idx = (idx + 1) % len(PHASE_SEQUENCE)
        _enter_state(next_idx, PHASE_SEQUENCE[next_idx], now, _lane_snapshot())


def advance_phase_if_due():
    """Called continuously by a background ticker thread. This is the ONLY
    function that ever changes which lane is green — it runs purely off
    elapsed wall-clock time, completely decoupled from how often sensor
    packets arrive."""
    now = time.time()
    with state_lock:
        state_name = shared_state['phase_state']
        started_at = shared_state['phase_started_at']
        duration = shared_state['phase_duration']
        idx = shared_state['phase_index']

    if now - started_at < duration:
        return

    if state_name.startswith('EMG_'):
        _advance_emergency_fsm(state_name, now)
        return

    if state_name.endswith('ALL_RED'):
        with state_lock:
            pending = shared_state['pending_emergency']
        if pending:
            _enter_emergency_green(pending, now)
            return

    next_idx = (idx + 1) % len(PHASE_SEQUENCE)
    _enter_state(next_idx, PHASE_SEQUENCE[next_idx], now, _lane_snapshot())


def _phase_ticker():
    while True:
        try:
            advance_phase_if_due()
        except Exception as e:
            log.error(f"Phase ticker error: {e}")
        time.sleep(0.25)


def handle_client(conn, addr, model):
    global _last_packet
    log.info(f"ESP32 connected from {addr}")
    add_event(f"ESP32 connected from {addr[0]}", category='connection')
    # A real device (or the standalone simulator) taking over means synthetic
    # scenario packets would otherwise keep interleaving with real ones.
    stop_scenario()
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
                update_lane_sensors(model, packet)

                with state_lock:
                    lanes_snap = {l: dict(shared_state['lanes'][l]) for l in LANES}
                    phase_state = shared_state['phase_state']
                    remaining = max(0.0, shared_state['phase_duration'] - (time.time() - shared_state['phase_started_at']))
                    emergency_active = phase_state.startswith('EMG_')
                    emergency_lane = shared_state['emergency_lane']
                    active_phase = 0 if phase_state.startswith('EW') else 1

                response = {
                    f'lane{l}_green': round(remaining) if lanes_snap[l]['signal'] in ('GREEN', 'YELLOW') else 0
                    for l in LANES
                }
                response.update({
                    f'lane{l}_signal': lanes_snap[l]['signal'] for l in LANES
                })
                response.update({
                    'amber_time':       YELLOW_TIME,
                    'active_phase':     active_phase,
                    'phase_state':      phase_state,
                    'emergency_active': emergency_active,
                    'emergency_lane':   emergency_lane,
                })
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
    threading.Thread(target=_phase_ticker, daemon=True).start()
    threading.Thread(target=_scenario_ticker, daemon=True).start()

    # Auto-start a default demo scenario so the dashboard never opens to an
    # empty intersection just because no ESP32/simulator has connected yet —
    # a real device connecting (handle_client) stops this automatically.
    start_scenario('mixed')

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

def get_state_snapshot():
    with state_lock:
        now = time.time()
        remaining = max(0.0, shared_state['phase_duration'] - (now - shared_state['phase_started_at']))
        lanes = {}
        for l in LANES:
            lane = dict(shared_state['lanes'][l])
            lane['green_time'] = round(remaining) if lane['signal'] in ('GREEN', 'YELLOW') else 0
            lanes[l] = lane
        return {
            'lanes':             lanes,
            'phase_state':       shared_state['phase_state'],
            'phase_duration':    shared_state['phase_duration'],
            'phase_remaining':   round(remaining, 1),
            'current_phase':     0 if shared_state['phase_state'].startswith('EW') else 1,
            'phase_green_time':  shared_state['phase_duration'],
            'emergency':         shared_state['emergency'],
            'emergency_lane':    shared_state['emergency_lane'],
            'pending_emergency': shared_state['pending_emergency'],
            'manual_override':   shared_state['manual_override'],
            'cycle_count':       shared_state['cycle_count'],
            'total_vehicles':    shared_state['total_vehicles'],
            'connected':         shared_state['connected'],
            'source':            shared_state['source'],
            'last_update':       shared_state['last_update'],
            'events':            shared_state['events'][:10],
            'active_scenario':   shared_state['active_scenario'],
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


def get_scenarios():
    return [
        {'key': k, 'label': SCENARIOS[k]['label'], 'description': SCENARIOS[k]['description']}
        for k in SCENARIO_ORDER
    ]


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
    """Called once by run.py before starting Flask/TCP threads. Safe to
    call twice (idempotent)."""
    history.init_db()


if __name__ == '__main__':
    model = load_model()
    init_app()
    start_tcp_server(model)
