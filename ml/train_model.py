# ============================================================
#  AI Traffic Control System
#  File: ml/train_model.py
#  Purpose: Train, evaluate and save the Random Forest
#           congestion classifier.
#
#  Run AFTER generate_dataset.py
#  Output: traffic_model.pkl (serialised model)
#          label_encoder.pkl (class label encoder)
# ============================================================

import numpy as np
import pandas as pd
import os
import joblib
import json

from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split, cross_val_score, StratifiedKFold
from sklearn.metrics import (accuracy_score, precision_score, recall_score,
                              f1_score, classification_report, confusion_matrix)
from sklearn.preprocessing import LabelEncoder

# ── Paths ─────────────────────────────────────────────────────
BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
DATASET     = os.path.join(BASE_DIR, 'traffic_dataset.csv')
MODEL_OUT   = os.path.join(BASE_DIR, 'traffic_model.pkl')
ENCODER_OUT = os.path.join(BASE_DIR, 'label_encoder.pkl')
METRICS_OUT = os.path.join(BASE_DIR, 'model_metrics.json')

# ── Hyperparameters (matching report: Section 3.5.4) ──────────
N_ESTIMATORS  = 100
CRITERION     = 'gini'
RANDOM_STATE  = 42
TEST_SIZE     = 0.30   # 70% train / 30% test
CV_FOLDS      = 5
CLASS_NAMES   = ['Low', 'Medium', 'High']


def load_data():
    if not os.path.exists(DATASET):
        raise FileNotFoundError(
            f"Dataset not found: {DATASET}\n"
            "Run generate_dataset.py first."
        )
    df = pd.read_csv(DATASET)
    X = df[['vehicle_count', 'avg_wait_time', 'sensor_activation']].values
    y = df['label'].values
    print(f"  Loaded {len(df)} samples from {DATASET}")
    return X, y


def train_and_evaluate(X, y):
    # ── Train / test split ────────────────────────────────────
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=TEST_SIZE, random_state=RANDOM_STATE, stratify=y
    )
    print(f"  Training samples : {len(X_train)}")
    print(f"  Test samples     : {len(X_test)}")

    # ── Train Random Forest ───────────────────────────────────
    clf = RandomForestClassifier(
        n_estimators=N_ESTIMATORS,
        criterion=CRITERION,
        random_state=RANDOM_STATE,
        n_jobs=-1
    )
    clf.fit(X_train, y_train)
    print(f"\n  Model trained: {N_ESTIMATORS} trees, {CRITERION} criterion")

    # ── Test set evaluation ───────────────────────────────────
    y_pred = clf.predict(X_test)
    acc    = accuracy_score(y_test, y_pred)
    prec   = precision_score(y_test, y_pred, average='weighted')
    rec    = recall_score(y_test, y_pred, average='weighted')
    f1     = f1_score(y_test, y_pred, average='weighted')
    cm     = confusion_matrix(y_test, y_pred)

    print("\n  ── Test Set Results ──────────────────────────────")
    print(f"  Accuracy  : {acc:.4f}  ({acc*100:.2f}%)")
    print(f"  Precision : {prec:.4f}")
    print(f"  Recall    : {rec:.4f}")
    print(f"  F1 Score  : {f1:.4f}")

    print("\n  Classification Report:")
    print(classification_report(y_test, y_pred, target_names=CLASS_NAMES))

    print("  Confusion Matrix (rows=actual, cols=predicted):")
    print(f"  {'':10s}  Low   Med   High")
    for i, row in enumerate(cm):
        print(f"  {CLASS_NAMES[i]:10s}  {row[0]:4d}  {row[1]:4d}  {row[2]:4d}")

    # ── 5-fold cross validation ───────────────────────────────
    skf = StratifiedKFold(n_splits=CV_FOLDS, shuffle=True, random_state=RANDOM_STATE)
    cv_scores = cross_val_score(clf, X, y, cv=skf, scoring='accuracy', n_jobs=-1)
    print(f"\n  ── {CV_FOLDS}-Fold Cross Validation ──────────────────────")
    print(f"  Fold scores : {[f'{s:.4f}' for s in cv_scores]}")
    print(f"  Mean        : {cv_scores.mean():.4f}")
    print(f"  Std Dev     : {cv_scores.std():.4f}")

    # ── Feature importances ───────────────────────────────────
    features = ['vehicle_count', 'avg_wait_time', 'sensor_activation']
    importances = clf.feature_importances_
    print(f"\n  ── Feature Importances ───────────────────────────")
    for feat, imp in sorted(zip(features, importances), key=lambda x: -x[1]):
        bar = '█' * int(imp * 40)
        print(f"  {feat:20s} : {imp:.4f}  {bar}")

    # ── Metrics dict (for saving) ─────────────────────────────
    metrics = {
        'accuracy':          round(float(acc), 4),
        'precision_weighted':round(float(prec), 4),
        'recall_weighted':   round(float(rec), 4),
        'f1_weighted':       round(float(f1), 4),
        'cv_mean':           round(float(cv_scores.mean()), 4),
        'cv_std':            round(float(cv_scores.std()), 4),
        'cv_folds':          CV_FOLDS,
        'n_estimators':      N_ESTIMATORS,
        'criterion':         CRITERION,
        'train_samples':     len(X_train),
        'test_samples':      len(X_test),
        'confusion_matrix':  cm.tolist(),
        'feature_importances': {f: round(float(i), 4) for f, i in zip(features, importances)}
    }

    return clf, metrics


def save_model(clf, metrics):
    # Save model
    joblib.dump(clf, MODEL_OUT)
    print(f"\n  Model saved    : {MODEL_OUT}")

    # Save metrics
    with open(METRICS_OUT, 'w') as f:
        json.dump(metrics, f, indent=2)
    print(f"  Metrics saved  : {METRICS_OUT}")


def main():
    print("=" * 52)
    print("  AI Traffic System — Model Training")
    print("=" * 52)

    X, y = load_data()
    clf, metrics = train_and_evaluate(X, y)
    save_model(clf, metrics)

    print("\n  All files saved. Run server.py to start the TCP server.")
    print("=" * 52)


if __name__ == '__main__':
    main()
