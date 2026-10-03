"""
train_isoforest.py — ฝึก Isolation Forest จำแนก batch (ตรวจจับระดับที่ 3)

unsupervised: ฝึกด้วย batch "ปกติ" เท่านั้น ไม่ต้องมี label ตอน train
(label ใช้เฉพาะตอน "ประเมิน" — ดู eval_isoforest.py / เล่มหัวข้อ 4.14)

input: ไฟล์ JSONL — หนึ่งบรรทัดต่อหนึ่ง batch: {"logs": [ {eventType, severity, sourceIp, source, cdeScope, createdAt}, ... ]}
  สร้างจาก log ปกติของระบบด้วย export_batches.py (ยังไม่ทำ) หรือมือ
output: data/isoforest_model.joblib = {"model", "feature_names", "n_train", "contamination", "feature_profile"}
  feature_profile = ช่วง p05/median/p95 ของแต่ละ feature ในชุดฝึก — batch_model.py ใช้เขียนเหตุผล
  ว่า batch ที่ถูกแจ้งหลุดช่วงที่ feature ไหน (ไม่มีผลต่อการทำนาย)

ใช้:
  python -m train_isoforest --input data/normal_batches.jsonl --contamination 0.02
  python -m train_isoforest --input data/normal_batches.jsonl --profile-only
    → เติม feature_profile ลงโมเดลที่มีอยู่ (--output) โดยไม่ train ใหม่ — ตัวโมเดลเดิมทุกอย่าง
      (ต้องใช้ไฟล์ batch ปกติชุดเดียวกับตอน train)
  (รันใน image ของ detection ที่มี scikit-learn: docker run ... python -m train_isoforest ...)

หมายเหตุความซื่อตรง: ตัวเลขประเมินที่ได้มาจากสถานการณ์ที่สร้างเอง น้ำหนักทางวิชาการ
น้อยกว่า DeepLog ที่วัดกับชุดข้อมูลมาตรฐาน HDFS — ต้องระบุข้อจำกัดนี้ในเล่ม
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from app.batch_features import FEATURE_NAMES, extract_features, feature_profile

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
    ap.add_argument("--profile-only", action="store_true",
                    help="ไม่ train · เติม feature_profile ลงโมเดลที่ --output ซึ่งมีอยู่แล้ว")
    args = ap.parse_args(argv)

    # import หนัก ๆ หลัง parse args เพื่อให้ --help ไม่ต้องมี sklearn
    from sklearn.ensemble import IsolationForest
    import joblib

    batches = load_batches(args.input)
    X = [extract_features(logs) for logs in batches]
    print(f"โหลด {len(X)} batch · feature {len(FEATURE_NAMES)} ตัว: {FEATURE_NAMES}")
    profile = feature_profile(X)

    if args.profile_only:
        bundle = joblib.load(args.output)
        if list(bundle.get("feature_names", [])) != list(FEATURE_NAMES):
            raise SystemExit("feature ของโมเดลไม่ตรงกับโค้ดปัจจุบัน — ต้อง train ใหม่")
        if bundle.get("n_train") not in (None, len(X)):
            raise SystemExit(f"โมเดล train ด้วย {bundle['n_train']} batch แต่ไฟล์นำเข้ามี {len(X)} — คนละชุด?")
        bundle["feature_profile"] = profile
        joblib.dump(bundle, args.output)
        print(f"เติม feature_profile → {args.output} (ไม่ได้ train ใหม่)")
        return 0

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
            "feature_profile": profile,
        },
        args.output,
    )
    print(f"บันทึกโมเดล → {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
