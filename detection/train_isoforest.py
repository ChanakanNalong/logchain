"""
train_isoforest.py — ฝึก Isolation Forest จำแนก batch (ตรวจจับระดับที่ 3)

unsupervised: ฝึกด้วย batch "ปกติ" เท่านั้น ไม่ต้องมี label ตอน train
(label ใช้เฉพาะตอน "ประเมิน" — ดู eval_isoforest.py / เล่มหัวข้อ 4.14)

input: ไฟล์ JSONL — หนึ่งบรรทัดต่อหนึ่ง batch: {"logs": [ {eventType, severity, sourceIp, source, cdeScope, createdAt}, ... ]}
  สร้างจาก log ปกติของระบบด้วย export_batches.py (ยังไม่ทำ) หรือมือ
output: data/isoforest_model.joblib = {"model", "feature_names", "n_train", "contamination"}

ใช้:
  python -m train_isoforest --input data/normal_batches.jsonl --contamination 0.02
  (รันใน image ของ detection ที่มี scikit-learn: docker run ... python -m train_isoforest ...)

หมายเหตุความซื่อตรง: ตัวเลขประเมินที่ได้มาจากสถานการณ์ที่สร้างเอง น้ำหนักทางวิชาการ
น้อยกว่า DeepLog ที่วัดกับชุดข้อมูลมาตรฐาน HDFS — ต้องระบุข้อจำกัดนี้ในเล่ม
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.batch_features import FEATURE_NAMES, extract_features

DEFAULT_OUT = Path(__file__).parent / "data" / "isoforest_model.joblib"


def load_batches(path: Path) -> list[list[dict]]:
    batches: list[list[dict]] = []
    with path.open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise SystemExit(f"บรรทัด {lineno}: JSON ไม่ถูกต้อง: {e}")
            logs = obj.get("logs", obj) if isinstance(obj, dict) else obj
            if not isinstance(logs, list) or not logs:
                raise SystemExit(f"บรรทัด {lineno}: ต้องมี key 'logs' เป็น list ที่ไม่ว่าง")
            batches.append(logs)
    if not batches:
        raise SystemExit("ไม่มี batch ในไฟล์นำเข้า")
    return batches


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ฝึก Isolation Forest จำแนก batch")
    ap.add_argument("--input", required=True, type=Path, help="ไฟล์ JSONL ของ batch ปกติ")
    ap.add_argument("--output", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--contamination", default="auto",
                    help="สัดส่วน outlier ที่คาด (float เช่น 0.02 หรือ 'auto')")
    ap.add_argument("--n-estimators", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    # import หนัก ๆ หลัง parse args เพื่อให้ --help ไม่ต้องมี sklearn
    from sklearn.ensemble import IsolationForest
    import joblib

    batches = load_batches(args.input)
    X = [extract_features(logs) for logs in batches]
    print(f"โหลด {len(X)} batch · feature {len(FEATURE_NAMES)} ตัว: {FEATURE_NAMES}")

    contamination = args.contamination
    if contamination != "auto":
        contamination = float(contamination)

    model = IsolationForest(
        n_estimators=args.n_estimators,
        contamination=contamination,
        random_state=args.seed,
    )
    model.fit(X)

    n_flagged = int((model.predict(X) == -1).sum())
    print(f"ฝึกเสร็จ · ในชุดฝึก flagged {n_flagged}/{len(X)} เป็น outlier")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(
        {
            "model": model,
            "feature_names": list(FEATURE_NAMES),
            "n_train": len(X),
            "contamination": contamination,
        },
        args.output,
    )
    print(f"บันทึกโมเดล → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
