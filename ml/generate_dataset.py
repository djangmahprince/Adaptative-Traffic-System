# ============================================================
#  AI Traffic Control System
#  File: ml/generate_dataset.py
#  Purpose: Generate synthetic labeled training dataset
#           simulating HC-SR04 sensor readings at the
#           four-lane intersection prototype.
#
#  Features per lane:
#    - vehicle_count     : estimated vehicles in lane
#    - avg_wait_time     : seconds vehicles have been waiting
#    - sensor_activation : total seconds sensor detected
#                          presence within polling window
#
#  Labels:
#    0 = Low    (0–2 vehicles,  0–10s wait)
#    1 = Medium (3–5 vehicles, 11–25s wait)
#    2 = High   (6+ vehicles,  >25s wait)
# ============================================================

import numpy as np
import pandas as pd
import os

# ── Reproducibility ───────────────────────────────────────────
SEED = 42
np.random.seed(SEED)

# ── Config ────────────────────────────────────────────────────
SAMPLES_PER_CLASS = 120   # 120 × 3 classes = 360 total (>300 minimum)
OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(OUTPUT_DIR, 'traffic_dataset.csv')


def generate_low(n):
    """
    Low congestion: 0–2 vehicles, 0–10s wait.
    Sensor activation proportionally low.
    Small random noise added to simulate real sensor variance.
    """
    vehicle_count     = np.random.randint(0, 3, n).astype(float)
    avg_wait_time     = np.random.uniform(0, 10, n)
    sensor_activation = vehicle_count * np.random.uniform(0.3, 0.7, n) \
                        + np.random.normal(0, 0.2, n)
    sensor_activation = np.clip(sensor_activation, 0, None)
    label = np.zeros(n, dtype=int)
    return vehicle_count, avg_wait_time, sensor_activation, label


def generate_medium(n):
    """
    Medium congestion: 3–5 vehicles, 11–25s wait.
    """
    vehicle_count     = np.random.randint(3, 6, n).astype(float)
    avg_wait_time     = np.random.uniform(11, 25, n)
    sensor_activation = vehicle_count * np.random.uniform(0.5, 0.9, n) \
                        + np.random.normal(0, 0.3, n)
    sensor_activation = np.clip(sensor_activation, 0, None)
    label = np.ones(n, dtype=int)
    return vehicle_count, avg_wait_time, sensor_activation, label


def generate_high(n):
    """
    High congestion: 6–12 vehicles, 26–60s wait.
    """
    vehicle_count     = np.random.randint(6, 13, n).astype(float)
    avg_wait_time     = np.random.uniform(26, 60, n)
    sensor_activation = vehicle_count * np.random.uniform(0.7, 1.0, n) \
                        + np.random.normal(0, 0.4, n)
    sensor_activation = np.clip(sensor_activation, 0, None)
    label = np.full(n, 2, dtype=int)
    return vehicle_count, avg_wait_time, sensor_activation, label


def build_dataframe(vc, wt, sa, lbl):
    return pd.DataFrame({
        'vehicle_count':     np.round(vc, 2),
        'avg_wait_time':     np.round(wt, 2),
        'sensor_activation': np.round(sa, 2),
        'label':             lbl
    })


def main():
    print("=" * 52)
    print("  AI Traffic System — Dataset Generator")
    print("=" * 52)

    n = SAMPLES_PER_CLASS

    # Generate each class
    low_data    = build_dataframe(*generate_low(n))
    medium_data = build_dataframe(*generate_medium(n))
    high_data   = build_dataframe(*generate_high(n))

    # Combine and shuffle
    dataset = pd.concat([low_data, medium_data, high_data], ignore_index=True)
    dataset = dataset.sample(frac=1, random_state=SEED).reset_index(drop=True)

    # Save
    dataset.to_csv(OUTPUT_FILE, index=False)

    # Report
    print(f"\n  Total samples generated : {len(dataset)}")
    print(f"  Samples per class       : {n}")
    print(f"  Class distribution:")
    for label, name in [(0,'Low'), (1,'Medium'), (2,'High')]:
        count = (dataset['label'] == label).sum()
        print(f"    {name:8s} (label={label}) : {count} samples")

    print(f"\n  Features per sample:")
    print(f"    - vehicle_count     (0 to 12)")
    print(f"    - avg_wait_time     (0 to 60 seconds)")
    print(f"    - sensor_activation (0 to ~12 seconds)")

    print(f"\n  Saved to: {OUTPUT_FILE}")
    print(f"\n  Run train_model.py next.")
    print("=" * 52)

    return dataset


if __name__ == '__main__':
    main()
