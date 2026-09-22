"""
parse_logs.py
แปลง HDFS.log ดิบ -> log key sequences ต่อ block_id
ผลลัพธ์: 2 ไฟล์
"""
import re
import csv
import json
from collections import OrderedDict
from drain3 import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig
from tqdm import tqdm

# ---- path ----
LOG_FILE    = "data/HDFS.log"
LABEL_FILE  = "data/anomaly_label.csv"
OUT_SEQ     = "data/hdfs_sequences.csv"
OUT_STATE   = "data/drain_state.json"

# regex ดึง block_id จากข้อความ log (เช่น blk_1608999687919862906)
BLOCK_RE = re.compile(r"(blk_-?\d+)")

MASK_PATTERNS = [
    (re.compile(r"blk_-?\d+"), "<BLK>"),                # block id
    (re.compile(r"/?\d+\.\d+\.\d+(:\d+)?"), "<IP>"),    # IP:port
    (re.compile(r"\b\d+\b"), "<NUM>"),                  # ตัวเลขทั่วไป
]

def mask_content(text: str) -> str:
    for pattern, reql in MASK_PATTERNS:
        text = pattern.sub(reql, text)
    return text

# ---- 1. setup Drain ----
config = TemplateMinerConfig()
config.profiling_enabled = False
# similarty threshold - สูง = แยก template ละเอียด, ต่ำ = รวมกันมาก
# 0.5 เป็นค่ามาครฐานที่ได้ ~47 log key สำหรับ HDFS
config.drain_sim_th = 0.4
template_miner = TemplateMiner(config=config)

# ---- 2. โหลด label ----
print("Loading labels...")
labels = {}
with open(LABEL_FILE) as f:
    reader = csv.DictReader(f)
    for row in reader:
        labels[row["BlockId"]] = row["Label"]
print(f" loaded {len(labels):,} block labels")

# ---- 3. parse log ทีละบรรทัด + จัดกลุ่มตาม block_id ----
# block_sequences: block_id -> list ของ log key (เรียงตามเวลาที่เจอ)
block_sequences = OrderedDict()

print("Parsing logs with Drain (อาจใช้เวลาสักครู่ ~11M บรรทัด)...")
with open(LOG_FILE, errors="ignore") as f:
    for line in tqdm(f, total=11_175_629):
        line = line.strip()
        if not line:
            continue

        # แยกส่วน heaer (6 ฟิลด์แรก) ออกจากข้อความจริง
        # format: date time pid level component: message
        parts = line.split(" ", 5)
        if len(parts) < 6:
            continue
        content = parts[5] # ข้อความจริงหลัง component

        # หา block_id จากข้อความเดิม (ก่อน mask) - สำคัญห้าม mask ก่อนหา
        blocks_in_line = BLOCK_RE.findall(content)

        # mask แล้วค่อยส่งให้ Drain (ลด template ที่ซ้ำซ้อน)
        masked = mask_content(content)
        # ให้ Drain เรียน template + ได้ cluster id (= log key)
        result = template_miner.add_log_message(masked)
        log_key = result["cluster_id"]


        # หา block_id ในข้อความ (1 บรรทัดอาจมีหลาย block - เก็บทุกตัว)
        for blk in blocks_in_line:
            block_sequences.setdefault(blk, []).append(log_key)

print(f"    found {len(block_sequences):,} unique blocks")
print(f"    discovered {len(template_miner.drain.clusters)} log keys (templates)")

# ---- 4. เขียน sequences + label ออกไฟล์ ----
print("Writing sequences...")
written = 0
skipped = 0
with open(OUT_SEQ, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["block_id", "label", "sequences"])
    for blk, seq in block_sequences.items():
        if blk not in labels:
            skipped += 1
            continue
        # sequences เก็บเป็น string  คั่นด้วย space เช่น "5 5 22 9"
        writer.writerow([blk, labels[blk], " ".join(map(str, seq))])
        written += 1

print(f" wrote {written:,} sequences ({skipped:,} block had no label, skipped)")

# ---- 5. เซฟ Drain template ไว้ดู/ใช้ตอน production ----
templates = {}
for cluster in template_miner.drain.clusters:
    templates[cluster.cluster_id] = cluster.get_template()
with open(OUT_STATE, "w") as f:
    json.dump(templates, f, indent=2)
print(f"    save {len(templates)} templates to {OUT_STATE}")

print("\nDone. ตัวอย่าง templates:")
for cid, tmpl in list(templates.items())[:5]:
    print(f"    log key {cid}: {tmpl}")