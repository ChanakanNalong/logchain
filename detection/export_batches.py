"""
export_batches.py — แปลง log ที่ export จาก DB ของ clone ให้เป็นชุด batch พร้อม label (สเตจ 4)

อ่าน log (JSONL หนึ่งบรรทัดต่อหนึ่ง log) เรียงตาม (createdAt, id) แล้วแบ่งเป็น batch ละ batch-size
เลียนแบบ sealBatchNow() (order createdAt,id · take 100) เพื่อให้ batch ตรงกับที่ระบบสร้างจริง
โดยไม่ต้องรอ cron seal (100 log/นาที)

label แต่ละ batch จาก source ที่ครองเสียงข้างมาก:
  - source ขึ้นต้น "app-"   → "normal"
  - source ขึ้นต้น "atk-X"  → "attack:X"
batch ที่ปนกัน (ไม่มี prefix ไหนถึง --purity) ถูกทิ้ง — eval จะได้ label สะอาด

export log จาก DB ของ clone (ตัวอย่างใน runbook):
  docker exec logchain-postgres psql -U logchain -d logchain -Atc \
    "select row_to_json(t) from (select id, source, event_type as \"eventType\", severity,
       host(source_id) as \"sourceIp\", cde_scope as \"cdeScope\", created_at as \"createdAt\"
     from logs order by created_at, id) t" > logs.jsonl

ใช้:
  python export_batches.py --input logs.jsonl --train-out train_normal.jsonl --eval-out eval_labeled.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter

APP_PREFIX = "app-"
ATK_PREFIX = "atk-"


def read_logs(path: str) -> list[dict]:
    logs = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                logs.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise SystemExit(f"บรรทัด {lineno}: JSON ไม่ถูกต้อง: {e}")
    return logs


def sort_logs(logs: list[dict]) -> list[dict]:
    """เรียงแบบเดียวกับ sealBatch: createdAt แล้ว id (id เป็น tie-break คงที่)"""
    return sorted(logs, key=lambda l: (str(l.get("createdAt", "")), str(l.get("id", ""))))


def chunk(logs: list[dict], size: int) -> list[list[dict]]:
    """แบ่งเป็นก้อนละ size · ทิ้งเศษก้อนสุดท้ายที่ไม่เต็ม (เหมือน batch ที่ยังไม่ครบ)"""
    return [logs[i : i + size] for i in range(0, len(logs) - size + 1, size)]


def batch_label(batch: list[dict], purity: float) -> str | None:
    """label จาก source prefix ที่ครองเสียง · คืน None ถ้าปนกันเกิน (ต่ำกว่า purity)"""
    prefixes = Counter()
    for log in batch:
        src = str(log.get("source", ""))
        if src.startswith(ATK_PREFIX):
            # atk-bruteforce → attack:bruteforce
            prefixes[f"attack:{src[len(ATK_PREFIX):].split('-')[0]}"] += 1
        elif src.startswith(APP_PREFIX):
            prefixes["normal"] += 1
        else:
            prefixes["other"] += 1
    if not prefixes:
        return None
    top, count = prefixes.most_common(1)[0]
    if count / len(batch) < purity or top == "other":
        return None
    return top


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="log → labeled batches (สเตจ 4)")
    ap.add_argument("--input", required=True, help="JSONL ของ log (export จาก DB)")
    ap.add_argument("--train-out", default="train_normal.jsonl", help="batch ปกติ (สำหรับ train)")
    ap.add_argument("--eval-out", default="eval_labeled.jsonl", help="batch ทุกชนิดพร้อม label")
    ap.add_argument("--batch-size", type=int, default=100)
    ap.add_argument("--purity", type=float, default=0.8, help="สัดส่วนขั้นต่ำที่ prefix ต้องครองจึงติด label")
    args = ap.parse_args(argv)

    logs = sort_logs(read_logs(args.input))
    batches = chunk(logs, args.batch_size)
    print(f"อ่าน {len(logs)} log → {len(batches)} batch (ละ {args.batch_size})")

    n_norm = n_atk = n_drop = 0
    label_counts = Counter()
    with open(args.train_out, "w", encoding="utf-8") as ftrain, \
         open(args.eval_out, "w", encoding="utf-8") as feval:
        for batch in batches:
            label = batch_label(batch, args.purity)
            if label is None:
                n_drop += 1
                continue
            label_counts[label] += 1
            feval.write(json.dumps({"label": label, "logs": batch}) + "\n")
            if label == "normal":
                n_norm += 1
                ftrain.write(json.dumps({"logs": batch}) + "\n")
            else:
                n_atk += 1

    print(f"  normal {n_norm} · attack {n_atk} · ทิ้ง(ปนกัน) {n_drop}")
    for lbl, c in sorted(label_counts.items()):
        print(f"    {lbl}: {c}")
    print(f"เขียน {args.train_out} (train) · {args.eval_out} (eval)")
    if n_norm < 30:
        print("⚠ batch ปกติน้อยกว่า 30 — IF อาจ underfit · เพิ่ม --normal-batches ตอน gen_traffic")
    return 0


if __name__ == "__main__":
    sys.exit(main())
