# ============================================================
#  AI Traffic Control System
#  File: simulator/esp32_simulator.py
#
#  Simulates realistic ESP32 sensor data. The server handles
#  all signal phasing logic — the simulator only sends
#  sensor readings (vehicle counts, wait times) and prints
#  what signal each lane actually gets back.
# ============================================================

import socket
import json
import time
import random

SERVER_IP     = '127.0.0.1'
SERVER_PORT   = 5050
POLL_INTERVAL = 2.0

SCENARIOS = [
    {
        'name': 'Morning Rush — Heavy traffic on A & C (horizontal road)',
        'cycles': 15,
        'lanes': {
            'A': {'count': (7, 11), 'wait': (30, 55)},
            'B': {'count': (0,  2), 'wait': (0,   9)},
            'C': {'count': (6, 10), 'wait': (28, 52)},
            'D': {'count': (0,  2), 'wait': (0,   8)},
        }
    },
    {
        'name': 'Off-Peak — Light traffic all lanes',
        'cycles': 10,
        'lanes': {
            'A': {'count': (0, 2), 'wait': (0,  9)},
            'B': {'count': (0, 2), 'wait': (0,  8)},
            'C': {'count': (0, 1), 'wait': (0,  5)},
            'D': {'count': (0, 2), 'wait': (0,  7)},
        }
    },
    {
        'name': 'Evening Rush — Heavy traffic on B & D (vertical road)',
        'cycles': 15,
        'lanes': {
            'A': {'count': (1,  3), 'wait': (3,  14)},
            'B': {'count': (7, 12), 'wait': (30, 58)},
            'C': {'count': (1,  3), 'wait': (3,  12)},
            'D': {'count': (6, 10), 'wait': (26, 50)},
        }
    },
    {
        'name': 'Emergency Vehicle on Lane A — all others must stop',
        'cycles': 6,
        'emergency_on_cycle': 2,
        'lanes': {
            'A': {'count': (4,  7), 'wait': (15, 30)},
            'B': {'count': (3,  5), 'wait': (12, 25)},
            'C': {'count': (2,  4), 'wait': (8,  18)},
            'D': {'count': (1,  3), 'wait': (4,  14)},
        }
    },
    {
        'name': 'Mixed — Medium congestion all lanes',
        'cycles': 12,
        'lanes': {
            'A': {'count': (3, 5), 'wait': (11, 24)},
            'B': {'count': (3, 6), 'wait': (12, 25)},
            'C': {'count': (3, 5), 'wait': (11, 23)},
            'D': {'count': (4, 6), 'wait': (14, 25)},
        }
    },
]


def make_packet(scenario, cycle, timestamp):
    emg = '0'
    if scenario.get('emergency_on_cycle') == cycle:
        emg = 'DE:AD:BE:EF'

    pkt = {'timestamp': timestamp, 'emergency': emg}
    for lane in ['A', 'B', 'C', 'D']:
        cfg   = scenario['lanes'][lane]
        count = random.randint(*cfg['count'])
        wait  = round(random.uniform(*cfg['wait']), 1)
        sa    = round(max(0, count * random.uniform(0.4, 0.9)
                         + random.gauss(0, 0.2)), 2)
        pkt[f'lane{lane}_count']      = count
        pkt[f'lane{lane}_wait']       = wait
        pkt[f'lane{lane}_activation'] = sa
    return pkt


def connect():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    for attempt in range(10):
        try:
            sock.connect((SERVER_IP, SERVER_PORT))
            print(f'  Connected to server at {SERVER_IP}:{SERVER_PORT}\n')
            sock.settimeout(5)
            return sock
        except (ConnectionRefusedError, socket.timeout):
            print(f'  Attempt {attempt+1}/10 failed — is run.py running? Retrying...')
            time.sleep(2)
    raise RuntimeError('Could not connect. Start run.py first.')


def run():
    print('=' * 60)
    print('  AI Traffic System — ESP32 Simulator')
    print('  Realistic two-phase intersection logic')
    print('  Phase 0: Lanes A+C GREEN  |  Phase 1: Lanes B+D GREEN')
    print('=' * 60)

    sock    = connect()
    buf     = ''
    pkt_num = 0

    try:
        for scenario in SCENARIOS:
            print(f'\n── {scenario["name"]} ──')
            print(f'   {scenario["cycles"]} cycles  '
                  f'({scenario["cycles"] * POLL_INTERVAL:.0f}s)\n')

            for cycle in range(scenario['cycles']):
                pkt_num += 1
                pkt = make_packet(scenario, cycle, int(time.time()))

                # Send
                try:
                    sock.sendall((json.dumps(pkt) + '\n').encode())
                except (BrokenPipeError, ConnectionResetError):
                    print('  Lost connection — reconnecting...')
                    sock = connect()
                    sock.sendall((json.dumps(pkt) + '\n').encode())

                # Print sent data
                emg_str = f'  *** EMERGENCY TAG: {pkt["emergency"]} ***' \
                          if pkt['emergency'] != '0' else ''
                print(f'  [{pkt_num:03d}] SENT  '
                      f'A:{pkt["laneA_count"]}v/{pkt["laneA_wait"]}s  '
                      f'B:{pkt["laneB_count"]}v/{pkt["laneB_wait"]}s  '
                      f'C:{pkt["laneC_count"]}v/{pkt["laneC_wait"]}s  '
                      f'D:{pkt["laneD_count"]}v/{pkt["laneD_wait"]}s'
                      + emg_str)

                # Receive response
                buf   = ''
                start = time.time()
                while time.time() - start < 5:
                    try:
                        chunk = sock.recv(1024).decode('utf-8')
                        if not chunk:
                            break
                        buf += chunk
                        if '\n' in buf:
                            line, buf = buf.split('\n', 1)
                            resp = json.loads(line.strip())

                            # Show which lanes are green/red clearly
                            def sig(lane):
                                s = resp.get(f'lane{lane}_signal', 'RED')
                                g = resp.get(f'lane{lane}_green', 0)
                                icon = '🟢' if s == 'GREEN' else '🔴'
                                return f'{icon} {lane}:{g}s'

                            phase = resp.get('active_phase', '?')
                            emg_a = ' [EMERGENCY OVERRIDE]' \
                                    if resp.get('emergency_active') else ''
                            print(f'         RESP  '
                                  f'{sig("A")}  {sig("B")}  '
                                  f'{sig("C")}  {sig("D")}  '
                                  f'Phase:{phase}{emg_a}')
                            break
                    except socket.timeout:
                        break

                time.sleep(POLL_INTERVAL)

        print('\n\nAll scenarios complete.')
        print('Check your dashboard at http://localhost:5000')

    except KeyboardInterrupt:
        print('\n\nSimulator stopped.')
    finally:
        sock.close()


if __name__ == '__main__':
    run()
