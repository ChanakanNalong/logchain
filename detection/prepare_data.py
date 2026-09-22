"""
prepate_data.py
แบ่ง sequences เป็น train (normal เท่านั้น) / test (normal + anomaly)
ผลลัพธ์: data/train.txt, data/test_normal.txt, data/test_abnormal.txt
แต่ละบรรทัด = 1 sequence (log keys คั่นด้วย space)
"""
import csv
import random

IN_SEQ = "data/hdfs_sequences.csv"
TRAIN_RATIO = 0.20 # ใช้ normal 1% สำหรับ train

# seed คงที่ - ทำให้ผลทดสอบ reproducible ทุกรอบได้ผลเหมือนเดิม
random.seed(42)

normal_seqs = []
abnormal_seqs = []

print("Loading sequences...")
csv.field_size_limit(10_000_000) # บาง sequences ยาวมาก ต้องขยาย limit
with open(IN_SEQ) as f:
    reader = csv.DictReader(f)
    for row in reader:
        seq = row["sequences"]
        if row["label"] == "Normal":
            normal_seqs.append(seq)
        else:
            abnormal_seqs.append(seq)

# shuffle ก่อน split (ตรงนี้คือจุดสำคัญที่ขาด)
random.shuffle(normal_seqs)
random.shuffle(abnormal_seqs)

print(f"    normal:     {len(normal_seqs):,}")
print(f"    abnormal:   {len(abnormal_seqs):,}")

# แบ่ง normal: ส่วนแรกไป train ที่เหลือไป test
split = int(len(normal_seqs) * TRAIN_RATIO)
train_normal = normal_seqs[:split]      # เอา N แรก
test_normal  = normal_seqs[split:]       # ที่เหลือไป test

print(f"\n  train (normal only): {len(train_normal):,}")
print(f"    test normal:        {len(test_normal):,}")
print(f"    test abnormal:      {len(abnormal_seqs):,}")

def write(path, seqs):
    with open(path, "w") as f:
        for s in seqs:
            f.write(s + "\n")

write("data/train.txt", train_normal)
write("data/test_normal.txt", test_normal)
write("data/test_abnormal.txt", abnormal_seqs)

print("\nDone. เขียน train.txt, test_normal.txt, test_abnormal.txt")