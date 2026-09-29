"""
eval_isoforest.py — วัดผลโมเดล Isolation Forest บน batch ที่มี label (สเตจ 4)

โหลด isoforest_model.joblib + eval_labeled.jsonl (จาก export_batches.py) แล้วคำนวณ
Precision / Recall / F1 / อัตราแจ้งเตือนเท็จ (FP ต่อ batch ปกติ) + recall แยกตามชนิดโจมตี

ground truth: label "normal" = ปกติ (0) · label ขึ้นต้น "attack:" = ผิดปกติ (1)
prediction: model.predict == -1 = แจ้งว่าผิดปกติ (positive)

ใช้ (ในอิมเมจ detection ที่มี scikit-learn):
  python eval_isoforest.py --model data/isoforest_model.joblib --eval eval_labeled.jsonl --out eval_result.json
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

from app.batch_features import extract_features


def read_labeled(path: str):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                obj = json.loads(line)
                rows.append((obj["label"], obj["logs"]))
    return rows


def prf(tp: int, fp: int, fn: int):
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return precision, recall, f1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="วัดผล Isolation Forest บน labeled batches")
    ap.add_argument("--model", default="data/isoforest_model.joblib")
    ap.add_argument("--eval", required=True, help="eval_labeled.jsonl จาก export_batches.py")
    ap.add_argument("--out", help="เขียนผลเป็น JSON (ไม่ระบุ = พิมพ์อย่างเดียว)")
    args = ap.parse_args(argv)

    import joblib

    bundle = joblib.load(args.model)
    model = bundle["model"]
    rows = read_labeled(args.eval)
    if not rows:
        raise SystemExit("eval ว่าง")

    tp = fp = tn = fn = 0
    per_attack_total = defaultdict(int)
    per_attack_hit = defaultdict(int)

    for label, logs in rows:
        is_attack = label.startswith("attack:")
        pred_anomaly = int(model.predict([extract_features(logs)])[0]) == -1
        if is_attack:
            per_attack_total[label] += 1
            if pred_anomaly:
                per_attack_hit[label] += 1
                tp += 1
            else:
                fn += 1
        else:
            if pred_anomaly:
                fp += 1
            else:
                tn += 1

    precision, recall, f1 = prf(tp, fp, fn)
    n_normal = fp + tn
    fp_rate = fp / n_normal if n_normal else 0.0

    print(f"batch: normal {n_normal} · attack {tp + fn}")
    print(f"  TP {tp} · FP {fp} · TN {tn} · FN {fn}")
    print(f"  Precision {precision:.4f} · Recall {recall:.4f} · F1 {f1:.4f}")
    print(f"  อัตราแจ้งเตือนเท็จ (FP/normal) {fp_rate:.4f} ({fp}/{n_normal})")
    print("  recall แยกตามชนิดโจมตี:")
    per_attack = {}
    for lbl in sorted(per_attack_total):
        r = per_attack_hit[lbl] / per_attack_total[lbl]
        per_attack[lbl] = {"hit": per_attack_hit[lbl], "total": per_attack_total[lbl], "recall": r}
        print(f"    {lbl}: {per_attack_hit[lbl]}/{per_attack_total[lbl]} = {r:.4f}")

    result = {
        "tp": tp, "fp": fp, "tn": tn, "fn": fn,
        "precision": precision, "recall": recall, "f1": f1,
        "fp_rate": fp_rate, "n_normal": n_normal, "n_attack": tp + fn,
        "per_attack": per_attack,
    }
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"เขียนผล → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
