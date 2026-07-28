from flask import Flask, render_template, jsonify, request

import server as srv


def create_app():
    app = Flask(__name__)
    # This is an actively-developed demo project — never let the browser
    # cache static JS/CSS across a code change without at least revalidating.
    app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

    @app.route('/')
    def live():
        return render_template('live.html', active_page='live')

    @app.route('/network')
    def network():
        return render_template('network.html', active_page='network')

    @app.route('/analytics')
    def analytics():
        return render_template('analytics.html', active_page='analytics')

    @app.route('/reports')
    def reports():
        return render_template('reports.html', active_page='reports')

    @app.route('/api/state')
    def api_state():
        return jsonify(srv.get_state_snapshot())

    @app.route('/api/metrics')
    def api_metrics():
        return jsonify(srv.get_metrics())

    @app.route('/api/events')
    def api_events():
        return jsonify(srv.get_state_snapshot()['events'])

    @app.route('/api/events/log')
    def api_events_log():
        category = request.args.get('category')
        limit = int(request.args.get('limit', 50))
        return jsonify({'events': srv.history.get_events(category, limit)})

    @app.route('/api/history')
    def api_history():
        limit = int(request.args.get('limit', 200))
        return jsonify({'cycles': srv.history.get_recent_cycles(limit)})

    @app.route('/api/network')
    def api_network():
        return jsonify(srv.get_network_snapshot())

    @app.route('/api/reports/summary')
    def api_reports_summary():
        range_ = request.args.get('range', 'today')
        return jsonify(srv.history.get_report_summary(range_))

    @app.route('/api/model')
    def api_model():
        try:
            return jsonify(srv.get_model_metrics())
        except FileNotFoundError:
            return jsonify({'error': 'model_metrics.json not found'}), 404

    @app.route('/api/override', methods=['POST'])
    def api_override():
        body = request.get_json(force=True, silent=True) or {}
        action = body.get('action')
        lane = body.get('lane')
        level = body.get('level')
        if action in ('emergency', 'congestion') and lane not in srv.LANES:
            return jsonify({'error': 'lane must be one of A/B/C/D'}), 400
        if action == 'congestion' and level not in (0, 1, 2):
            return jsonify({'error': 'level must be 0, 1 or 2'}), 400
        ok = srv.apply_manual_override(action, lane=lane, level=level)
        if not ok:
            return jsonify({'error': 'unknown action'}), 400
        return jsonify({'ok': True})

    return app
