# AI Traffic Control System — Handoff

KNUST Department of Computer Engineering — AI-Based Intelligent Traffic Congestion Prediction
and Control System. This gets you from a fresh clone to a running dashboard.

## What this project is

An ESP32-based traffic controller for a 4-lane intersection. An ESP32 (not built yet — see
"Current status" below) reads HC-SR04 ultrasonic sensors and an RC522 RFID reader, sends
readings over TCP to a Python server, which runs a trained Random Forest model to predict
congestion per lane and decides signal timing. A Flask dashboard shows it all live in the
browser. Until the physical hardware exists, a simulator script stands in for the ESP32.

## Prerequisites

- Python 3.10+ (developed on 3.12)
- `pip`
- No Node.js, no database server, no other services — everything is plain Python + a browser

## First-time setup

Get the project folder onto your PC — either `git clone` the repo if it's been pushed to
GitHub, or just unzip/copy the folder you were sent. Then, from inside the project folder:

```bash
pip install -r requirements.txt
```

That's it. The trained ML model (`ml/traffic_model.pkl`) is already included, so you don't need
to regenerate or retrain anything to get started.

*(If you received this as a git repository and want version history/collaboration, ask whoever
sent it for the GitHub URL once it's up — worth switching to `git clone` at that point instead
of passing zips back and forth.)*

## Running it

**Terminal 1** — starts the TCP server (port 5050, listens for the ESP32/simulator) and the
Flask dashboard together, in one process:
```bash
python run.py
```
Then open **http://localhost:5000** in a browser.

**Terminal 2** — since the physical ESP32 hardware doesn't exist yet, run the simulator to feed
it realistic fake sensor data:
```bash
python simulator/esp32_simulator.py
```
It runs through 5 scenarios (morning rush, off-peak, evening rush, an emergency-vehicle event,
mixed congestion — about 2 minutes) and then exits. Rerun it any time you want more live data;
the dashboard just sits waiting for a connection when it's not running.

`Ctrl+C` in either terminal stops that process. Stop and restart `run.py` freely — its history
(model decisions, connection log, cycle stats) persists to `server/traffic_history.db` across
restarts, so you won't lose data between runs. That file is gitignored (local-only, not
committed) — everyone gets a fresh history the first time they run it.

## What you'll see

Four pages, navigable from the header:
- **Live Control** — the 2D intersection view with live traffic, manual override controls
  (Trigger Emergency / Force Congestion / Reset), current signal states, and per-lane stats
- **Network** — ESP32/simulator connection status and history
- **Analytics** — congestion/queue/throughput charts and the full decision log
- **Reports** — vehicle/cycle/incident totals and the trained model's real performance metrics

The **Trigger Emergency** and **Force Congestion** buttons are fully functional — they call
through to the real server logic (`server/server.py`), not just the UI.

## Project structure

```
run.py                    ← start here: python run.py
requirements.txt
ml/                        ← trained Random Forest model + training scripts
  generate_dataset.py
  train_model.py
  traffic_model.pkl        ← already trained, committed to git
  model_metrics.json       ← real accuracy/precision/recall numbers, shown on Reports page
server/
  server.py                ← TCP server + ML inference + two-phase signal logic
  history.py                ← SQLite persistence for Analytics/Network/Reports
dashboard/
  app.py                    ← Flask app (imports server.py directly, no separate process)
  templates/                ← Jinja2 pages (live/network/analytics/reports)
  static/                   ← plain CSS/JS, no build step, no npm
simulator/
  esp32_simulator.py        ← stands in for the ESP32 until hardware exists
firmware/
  traffic_controller/traffic_controller.ino   ← real ESP32 firmware (Arduino IDE)
hardware/
  README.md                 ← full wiring/schematic reference — read this before building hardware
```

## Current project status

- ✅ ESP32 firmware (complete, in `firmware/`)
- ✅ Python server + ML model (complete, in `server/` and `ml/`)
- ✅ Web dashboard (complete, in `dashboard/`)
- ⏳ Physical hardware build — LED wiring in progress, sensors/RFID/cardboard model pending
  (see `hardware/README.md` for the full wiring reference and a flagged GPIO strapping-pin
  concern worth checking before wiring)
- ⏳ Integration testing against real hardware (once it's built)

Nothing in the software stack needs to change when the real ESP32 is ready — it just connects
to the same TCP port the simulator uses, sending the same JSON packet format.

## Troubleshooting

| Problem | Fix |
|---|---|
| `ModuleNotFoundError` on startup | Run `pip install -r requirements.txt` again |
| "Model not found" error | Shouldn't happen (`traffic_model.pkl` is committed) — if it does, run `python ml/generate_dataset.py` then `python ml/train_model.py` |
| Dashboard shows "Waiting for ESP32" forever | Run the simulator in a second terminal, or check nothing else is already using port 5050 |
| Port already in use | Something else (an old `run.py`) is still running — stop it first |
| Simulator: "Connection refused" | Start `run.py` first and wait for its startup banner before starting the simulator |
