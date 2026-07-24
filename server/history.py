# ============================================================
#  AI Traffic Control System
#  File: server/history.py
#
#  Lightweight SQLite persistence so the dashboard's Analytics,
#  Network and Reports pages survive a page reload or a server
#  restart. Every processed sensor cycle and every logged event
#  (decision / emergency / override / connection) is appended
#  here; nothing here affects the live signal-timing logic.
# ============================================================

import os
import sqlite3
import threading
import time
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'traffic_history.db')

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def init_db():
    global _conn
    _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    with _lock:
        _conn.execute('''
            CREATE TABLE IF NOT EXISTS cycles (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                ts             TEXT    NOT NULL,
                epoch          REAL    NOT NULL,
                phase          INTEGER,
                emergency      INTEGER,
                emergency_lane TEXT,
                total_vehicles INTEGER,
                cycle_count    INTEGER,
                latency_ms     REAL,
                a_count INTEGER, a_wait REAL, a_level INTEGER, a_confidence REAL, a_signal TEXT,
                b_count INTEGER, b_wait REAL, b_level INTEGER, b_confidence REAL, b_signal TEXT,
                c_count INTEGER, c_wait REAL, c_level INTEGER, c_confidence REAL, c_signal TEXT,
                d_count INTEGER, d_wait REAL, d_level INTEGER, d_confidence REAL, d_signal TEXT
            )
        ''')
        _conn.execute('''
            CREATE TABLE IF NOT EXISTS events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       TEXT    NOT NULL,
                epoch    REAL    NOT NULL,
                category TEXT    NOT NULL,
                msg      TEXT    NOT NULL
            )
        ''')
        _conn.commit()


def record_cycle(snapshot: dict):
    with _lock:
        _conn.execute('''
            INSERT INTO cycles (
                ts, epoch, phase, emergency, emergency_lane, total_vehicles, cycle_count, latency_ms,
                a_count, a_wait, a_level, a_confidence, a_signal,
                b_count, b_wait, b_level, b_confidence, b_signal,
                c_count, c_wait, c_level, c_confidence, c_signal,
                d_count, d_wait, d_level, d_confidence, d_signal
            ) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?)
        ''', (
            datetime.now().strftime('%H:%M:%S'), time.time(),
            snapshot['phase'], int(snapshot['emergency']), snapshot['emergency_lane'],
            snapshot['total_vehicles'], snapshot['cycle_count'], snapshot['latency_ms'],
            *snapshot['A'], *snapshot['B'], *snapshot['C'], *snapshot['D'],
        ))
        _conn.commit()


def record_event(message: str, category: str = 'decision') -> str:
    ts = datetime.now().strftime('%H:%M:%S')
    with _lock:
        _conn.execute(
            'INSERT INTO events (ts, epoch, category, msg) VALUES (?,?,?,?)',
            (ts, time.time(), category, message),
        )
        _conn.commit()
    return ts


def get_recent_cycles(limit: int = 200) -> list[dict]:
    with _lock:
        cur = _conn.execute('SELECT * FROM cycles ORDER BY id DESC LIMIT ?', (limit,))
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, row)) for row in cur.fetchall()]
    rows.reverse()
    return rows


def get_events(category: str | None = None, limit: int = 50) -> list[dict]:
    with _lock:
        if category:
            cur = _conn.execute(
                'SELECT ts, category, msg FROM events WHERE category = ? ORDER BY id DESC LIMIT ?',
                (category, limit),
            )
        else:
            cur = _conn.execute(
                'SELECT ts, category, msg FROM events ORDER BY id DESC LIMIT ?', (limit,)
            )
        return [{'time': r[0], 'category': r[1], 'msg': r[2]} for r in cur.fetchall()]


def get_network_stats() -> dict:
    with _lock:
        cur = _conn.execute(
            "SELECT ts, epoch, msg FROM events WHERE category = 'connection' "
            "ORDER BY id DESC LIMIT 20"
        )
        history_rows = [{'time': r[0], 'epoch': r[1], 'msg': r[2]} for r in cur.fetchall()]
        connect_count = _conn.execute(
            "SELECT COUNT(*) FROM events WHERE category = 'connection' AND msg LIKE 'ESP32 connected%'"
        ).fetchone()[0]
        disconnect_count = _conn.execute(
            "SELECT COUNT(*) FROM events WHERE category = 'connection' AND msg LIKE 'ESP32 disconnected%'"
        ).fetchone()[0]
    return {
        'history': history_rows,
        'connect_count': connect_count,
        'disconnect_count': disconnect_count,
    }


def get_report_summary(range_: str = 'all') -> dict:
    since_epoch = 0.0
    if range_ == 'today':
        midnight = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        since_epoch = midnight.timestamp()

    with _lock:
        row = _conn.execute('''
            SELECT COUNT(*),
                   COALESCE(MAX(total_vehicles) - MIN(total_vehicles), 0),
                   AVG(a_wait), AVG(b_wait), AVG(c_wait), AVG(d_wait),
                   AVG(a_count), AVG(b_count), AVG(c_count), AVG(d_count),
                   AVG(latency_ms)
            FROM cycles WHERE epoch >= ?
        ''', (since_epoch,)).fetchone()
        incidents = _conn.execute(
            "SELECT COUNT(*) FROM events WHERE category = 'emergency' AND epoch >= ? "
            "AND msg LIKE 'RFID tag detected%'",
            (since_epoch,),
        ).fetchone()[0]

    cycles_n, vehicles_delta, aw, bw, cw, dw, ac, bc, cc, dc, avg_latency = row
    lane_avgs = {
        'A': {'avg_wait': round(aw or 0, 1), 'avg_count': round(ac or 0, 1)},
        'B': {'avg_wait': round(bw or 0, 1), 'avg_count': round(bc or 0, 1)},
        'C': {'avg_wait': round(cw or 0, 1), 'avg_count': round(cc or 0, 1)},
        'D': {'avg_wait': round(dw or 0, 1), 'avg_count': round(dc or 0, 1)},
    }
    busiest = max(lane_avgs, key=lambda l: lane_avgs[l]['avg_count']) if cycles_n else None

    return {
        'range': range_,
        'cycles': cycles_n or 0,
        'vehicles': int(vehicles_delta or 0),
        'incidents': incidents or 0,
        'busiest_lane': busiest,
        'lanes': lane_avgs,
        'avg_latency_ms': round(avg_latency or 0, 2),
    }
