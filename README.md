# AI-Based Intelligent Traffic Congestion Prediction and Control System

A KNUST Department of Computer Engineering final-year project that replaces fixed-time traffic signals with an adaptive, AI-driven control system for a four-lane intersection, combining embedded sensing, machine learning congestion prediction, and RFID-based emergency vehicle prioritization.

## Overview

Fixed-time traffic signals in Ghanaian cities (Accra, Kumasi, Takoradi) run on rigid, pre-programmed timing cycles that ignore real-time traffic conditions, causing unnecessary delays, fuel waste, and no priority for emergency vehicles. This project designs and implements a low-cost prototype that:

- Senses real-time vehicle counts and queue activity per lane using ultrasonic sensors
- Classifies congestion level (Low / Medium / High) using a trained Random Forest model
- Dynamically adjusts traffic signal green-phase durations based on predicted congestion
- Detects RFID-tagged emergency vehicles and overrides normal signal cycles to grant right of way
- Displays live traffic and system status on a web-based monitoring dashboard

## System Architecture

The system is organized into five functional layers:

1. **Data Acquisition** — HC-SR04 ultrasonic sensors and RC522 RFID reader collect real-time traffic and emergency vehicle data at each lane
2. **Edge Processing** — ESP32 microcontroller filters sensor noise and formats readings into structured JSON packets
3. **AI Prediction** — A Python server runs a Random Forest classifier to predict congestion level from the incoming data
4. **Traffic Control** — An adaptive algorithm converts congestion predictions into signal timing commands, with an emergency override mode
5. **Visualization & Monitoring** — A Flask-based web dashboard displays live congestion levels, signal states, and system events

The ESP32 and Python server communicate over a local Wi-Fi network via TCP sockets, with the ESP32 acting as the client sending data every two seconds and the server returning signal timing instructions.

## Hardware

| Component | Specification | Qty | Purpose |
|---|---|---|---|
| Microcontroller | ESP32-WROOM-32 (dual-core, 240 MHz, Wi-Fi) | 1 | Central controller and communication hub |
| Ultrasonic Sensor | HC-SR04 (2–400 cm range) | 4 | Vehicle presence and queue detection per lane |
| RFID Reader | RC522 (13.56 MHz, SPI) | 1 | Emergency vehicle identification |
| RFID Tags | MIFARE 1K Passive | 2+ | Attached to emergency vehicle models |
| LED Traffic Lights | Red, Amber, Green (5 mm) | 12 | Signal actuation (3 per lane, 4 lanes) |
| Resistors | 1KΩ, 2KΩ (ECHO voltage dividers), 10KΩ (strapping pin pull-ups) | Various | Level shifting and safe boot behavior |

## Software Stack

- **Firmware:** Arduino (C++) — `traffic_controller.ino`
- **Machine Learning:** Python, scikit-learn (RandomForestClassifier — 100 trees, Gini impurity, 70/30 train-test split, 5-fold cross-validation)
- **Server:** Python TCP socket server + Flask REST API (`server.py`, `app.py`)
- **Simulation:** `esp32_simulator.py`, `generate_dataset.py`
- **Dashboard:** HTML, CSS, JavaScript, Chart.js (`dashboard.html`)
- **PCB/Schematics:** KiCad

## Machine Learning Model

- **Algorithm:** Random Forest Classifier
- **Input features:** vehicle count per lane, average waiting time, sensor activation duration
- **Classes:** Low, Medium, High congestion
- **Dataset:** 360 synthetically generated, balanced samples (120 per class) from the prototype hardware
- **Training/validation:** 70/30 split with 5-fold stratified cross-validation

## Key Design Decisions

- **Two-phase signal logic:** at most two lanes are green simultaneously (Phase 0 = Lanes A+C, Phase 1 = Lanes B+D). Thus, not all four lanes at once
- **Emergency override:** queued at the next all-red boundary rather than instantly interrupting the active phase, with a minimum 30-second interval between overrides
- **Amber (yellow) transition:** fixed at 3 seconds across all congestion levels

## Repository Structure

```
├── firmware/
│   └── traffic_controller/
│       └── traffic_controller.ino   # ESP32 firmware
├── ml/
│   ├── generate_dataset.py          # Synthetic dataset generation
│   ├── train_model.py               # Random Forest training & evaluation
│   ├── traffic_dataset.csv          # Generated training data
│   ├── traffic_model.pkl            # Trained model (serialized)
│   └── model_metrics.json           # Accuracy, precision, recall, F1 per class
├── server/
│   ├── server.py                    # TCP socket server + ML inference
│   ├── history.py                   # Historical data logging
│   └── traffic_history.db           # SQLite database
├── dashboard/
│   ├── app.py                       # Flask web application
│   ├── templates/                   # live, analytics, network, reports pages
│   └── static/                      # JS and CSS for the dashboard
├── simulator/
│   └── esp32_simulator.py           # Hardware simulator for testing without the physical prototype
├── hardware/
│   ├── traffic_system.kicad_pro     # KiCad project
│   ├── traffic_system.kicad_sch     # KiCad schematic
│   ├── BOM.csv                      # Bill of materials
│   ├── pin_assignment.md            # ESP32 pin mapping
│   ├── connector_list.md            # Connector reference
│   └── README.md                    # Hardware-specific notes
├── run.py                           # Main entry point
├── requirements.txt                 # Python dependencies
├── PROJECT_LOGIC_SPEC.md            # System logic specification
├── TRAFFIC_FLOW_LOGIC.md            # Traffic flow / signal logic documentation
└── HANDOFF.md                       # Project handoff notes
```

## Getting Started

1. Clone the repository
2. Flash `traffic_controller.ino` to the ESP32 via the Arduino IDE (set your Wi-Fi credentials — a mobile hotspot is required, as institutional networks may block TCP socket traffic)
3. Install Python dependencies: `pip install scikit-learn flask joblib`
4. Train the model: `python ml/train_model.py`
5. Start the server: `python server/server.py`
6. Open the dashboard in a browser on the same network

## Performance Evaluation

The system is benchmarked against a fixed-time baseline (uniform 30-second green phase) using:

- Average vehicle waiting time
- Maximum queue length
- Intersection throughput
- ML prediction accuracy
- Emergency response time
- Prediction latency

## Team

- Prince Tetteh Djangmah
- Peniel Gregory Osei Agyemang
- Boatemaa Akosua Osei

**Supervisor:** Professor Emmanuel K. Akowuah

Department of Computer Engineering, Faculty of Electrical and Computer Engineering, College of Engineering, Kwame Nkrumah University of Science and Technology (KNUST)
