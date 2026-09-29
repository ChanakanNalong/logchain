#!/usr/bin/env bash
# ครึ่ง ML ของสเตจ 4 (ไม่ต้องใช้ secret) — รับ logs.jsonl ที่ export จาก clone แล้ว
# ทำ export → train → eval ให้จบในคำสั่งเดียว
#
# ครึ่งที่ต้อง secret/clone (เจ้าของทำก่อน · runbook ขั้น 1–4):
#   สลับ clone → gen_traffic.py → export logs เป็น JSONL
# แล้วส่ง logs.jsonl มา รันตัวนี้ต่อได้เลย (บนชุดจริงหรือที่ไหนก็ได้ที่มี image logchain-detection:dev)
#
# ใช้: ./scripts/isoforest-train-eval.sh <logs.jsonl> [out-dir] [contamination]
set -euo pipefail
LOGS="${1:?usage: $0 <logs.jsonl> [out-dir] [contamination]}"
OUT="${2:-$HOME/Documents/logchain-data/isoforest}"
CONTAM="${3:-0.02}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
IMG="logchain-detection:dev"

[ -f "$LOGS" ] || { echo "ไม่พบไฟล์: $LOGS"; exit 1; }
mkdir -p "$OUT"
LOGS_ABS="$(cd "$(dirname "$LOGS")" && pwd)/$(basename "$LOGS")"

echo "▶ 1/3 export_batches (host python3, stdlib)"
python3 "$REPO/detection/export_batches.py" --input "$LOGS_ABS" \
  --train-out "$OUT/train_normal.jsonl" --eval-out "$OUT/eval_labeled.jsonl"

echo "▶ 2/3 train_isoforest (image · contamination=$CONTAM)"
docker run --rm --user "$(id -u):$(id -g)" -v "$REPO/detection:/w" -v "$OUT:/data" -w /w --entrypoint python "$IMG" \
  train_isoforest.py --input /data/train_normal.jsonl --output /data/isoforest_model.joblib \
  --contamination "$CONTAM"

echo "▶ 3/3 eval_isoforest (image)"
docker run --rm --user "$(id -u):$(id -g)" -v "$REPO/detection:/w" -v "$OUT:/data" -w /w --entrypoint python "$IMG" \
  eval_isoforest.py --model /data/isoforest_model.joblib --eval /data/eval_labeled.jsonl \
  --out /data/eval_result.json

echo
echo "✓ เสร็จ · ผลอยู่ที่ $OUT/"
echo "  - isoforest_model.joblib  → copy ไป detection/data/ ของชุดจริง แล้ว build detection-api"
echo "  - eval_result.json        → เติมเลขลงเล่ม: python3 detection/fill_book_draft.py $OUT/eval_result.json"
