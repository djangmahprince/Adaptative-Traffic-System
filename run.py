import threading
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, 'server'))
sys.path.insert(0, os.path.join(BASE, 'dashboard'))
sys.path.insert(0, os.path.join(BASE, 'ml'))

def main():
    print("=" * 54)
    print("  AI Traffic Control System - Starting Up")
    print("=" * 54)

    from server import load_model, start_tcp_server
    model = load_model()

    tcp_thread = threading.Thread(
        target=start_tcp_server,
        args=(model,),
        daemon=True
    )
    tcp_thread.start()
    print("  TCP server      : port 5050")

    from app import create_app
    flask_app = create_app()
    print("  Flask dashboard : http://localhost:5000")
    print("  (Press Ctrl+C to stop)")
    print("=" * 54)
    flask_app.run(host='0.0.0.0', port=5000, debug=False, use_reloader=False)

if __name__ == '__main__':
    main()