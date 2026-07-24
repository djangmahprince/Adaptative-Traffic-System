import threading
import sys
import os

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE, 'server'))
sys.path.insert(0, os.path.join(BASE, 'ml'))

def main():
    print("=" * 54)
    print("  AI Traffic Control System - Starting Up")
    print("=" * 54)

    from server import load_model, start_tcp_server, start_state_bridge
    model = load_model()

    tcp_thread = threading.Thread(
        target=start_tcp_server,
        args=(model,),
        daemon=True
    )
    tcp_thread.start()
    print("  TCP server      : port 5050")

    bridge_thread = threading.Thread(
        target=start_state_bridge,
        daemon=True
    )
    bridge_thread.start()
    print("  State bridge    : http://127.0.0.1:5051/api/state (internal)")
    print()
    print("  This process only runs the TCP server + ML model.")
    print("  Start the dashboard separately:")
    print("    cd dashboard && npm start")
    print("    -> http://localhost:5000")
    print("=" * 54)
    print("  (Press Ctrl+C to stop)")

    try:
        tcp_thread.join()
    except KeyboardInterrupt:
        print("\n  Shutting down.")

if __name__ == '__main__':
    main()
