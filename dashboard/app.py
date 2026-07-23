import sys
import os
from flask import Flask, render_template, jsonify

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, '..', 'server'))

from server import shared_state, state_lock, LANES, AMBER_TIME


def create_app():
    app = Flask(__name__)

    @app.route('/')
    def index():
        return render_template('dashboard.html')

    @app.route('/api/state')
    def api_state():
        with state_lock:
            data = {
                'lanes':          {k: dict(v) for k, v in shared_state['lanes'].items()},
                'emergency':      shared_state['emergency'],
                'emergency_lane': shared_state['emergency_lane'],
                'cycle_count':    shared_state['cycle_count'],
                'total_vehicles': shared_state['total_vehicles'],
                'connected':      shared_state['connected'],
                'last_update':    shared_state['last_update'],
                'events':         shared_state['events'][:10],
            }
        return jsonify(data)

    @app.route('/api/metrics')
    def api_metrics():
        with state_lock:
            lanes  = {k: dict(v) for k, v in shared_state['lanes'].items()}
            total  = shared_state['total_vehicles']
            cycles = shared_state['cycle_count']
        waits = [lanes[l]['avg_wait_time'] for l in LANES]
        avg_wait = round(sum(waits) / len(waits), 1) if waits else 0
        return jsonify({
            'total_vehicles': total,
            'cycle_count':    cycles,
            'avg_wait_time':  avg_wait,
        })

    @app.route('/api/events')
    def api_events():
        with state_lock:
            events = list(shared_state['events'])
        return jsonify(events)

    return app