"""
แปลงข้อความ log → log key ด้วย template ชุดเดียวกับที่ใช้ train DeepLog (data/drain_state.json)

เดิม consumer สร้าง Drain ใหม่เปล่า ๆ ตอน start แล้ว add_log_message() — cluster id แจกตามลำดับที่เจอตอนรัน
ไม่ตรงกับ id ตอน train (log ที่ train เป็น key 5 อาจได้ key 1) → โมเดลทำนายบน key ผิดชุด
และ Drain ยังเรียนต่อได้ key เกิน NUM_CLASSES - 1 → API ตอบ 422

ที่นี่ไม่เรียนเพิ่ม: เทียบกับ template ที่ train ไว้แบบเดียวกับ Drain — จำนวน token ต้องเท่ากัน
`<*>` แทนได้ 1 token · ตรงหลายตัวเลือกตัวที่ token จริงตรงมากที่สุด · ไม่ตรงเลย = UNKNOWN_KEY (0)
ซึ่งเป็น index ที่เว้นไว้สำหรับ padding/unknown อยู่แล้ว (NUM_CLASSES = key + 1)

mask() ใช้ร่วมกับ parse_logs.py — ตอน train กับตอนรันต้อง mask เหมือนกันทุกตัวอักษร
"""
import json
import re
from collections import defaultdict
from pathlib import Path

DRAIN_STATE_PATH = Path(__file__).parent.parent / "data" / "drain_state.json"
UNKNOWN_KEY = 0
WILDCARD = "<*>"

# ตอนรันจริง message ผ่าน PII masking ของ backend (src/logs/services/pii-masking.service.ts) มาก่อน
# ซึ่งไม่มีตอน train (HDFS.log ดิบ) — ต้องรับทั้งสองแบบให้ออกมาเป็น token เดียวกัน ไม่งั้น ~66% ของบรรทัด HDFS เป็น UNKNOWN_KEY
#   IP: 10.250.19.102 → 10.250.19.xxx · block id ติดลบ 13/16 หลัก → blk_-[THAI_ID] / blk_-[PAN]
MASK_PATTERNS = [
    (re.compile(r"blk_-?(?:\d+|\[[A-Z_]+\])"), "<BLK>"),                  # block id
    (re.compile(r"/?\d+\.\d+\.\d+\.(?:\d+|xxx)(:\d+)?"), "<IP>"),         # IPv4 (+ port)
    (re.compile(r"\b\d+\b"), "<NUM>"),                                    # ตัวเลขทั่วไป
]


def mask(text: str) -> str:
    for pattern, repl in MASK_PATTERNS:
        text = pattern.sub(repl, text)
    return text


class LogKeyMatcher:
    def __init__(self, templates: dict):
        # จัดกลุ่มตามจำนวน token — Drain เองก็แยก cluster ตามความยาวก่อน
        self._by_len: dict[int, list[tuple[int, list[str]]]] = defaultdict(list)
        for key, template in templates.items():
            tokens = template.split()
            self._by_len[len(tokens)].append((int(key), tokens))
        self.num_keys = len(templates)

    @classmethod
    def from_file(cls, path: Path = DRAIN_STATE_PATH) -> "LogKeyMatcher":
        with open(path) as f:
            return cls(json.load(f))

    def match(self, masked: str) -> int:
        """ข้อความที่ mask แล้ว → log key (UNKNOWN_KEY ถ้าไม่ตรง template ไหน)"""
        tokens = masked.split()
        best_key, best_score = UNKNOWN_KEY, -1
        for key, template in self._by_len.get(len(tokens), ()):
            score = 0
            for expected, actual in zip(template, tokens):
                if expected == WILDCARD:
                    continue
                if expected != actual:
                    break
                score += 1
            else:
                if score > best_score or (score == best_score and key < best_key):
                    best_key, best_score = key, score
        return best_key
