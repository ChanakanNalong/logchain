"""
batch_features.py — คำนวณ feature ระดับ batch สำหรับ Isolation Forest (ตรวจจับระดับที่ 3)

บริสุทธิ์: ใช้แค่ stdlib (math / collections / datetime) ไม่พึ่ง numpy/sklearn
จึง import + test ได้โดยไม่ต้องมี image ของ detection · ใช้ร่วมกันทั้งตอน train
(train_isoforest.py) และตอน serve (batch_model.py) — feature ต้องคำนวณสูตรเดียวกันเสมอ

หน่วยวิเคราะห์คือ "batch" (log ~100 รายการที่ปิดชุดพร้อมกัน) ไม่ใช่ log ทีละตัว
มองภาพรวมของช่วงเวลาที่กฎทีละ log กับ DeepLog (ทีละลำดับ) มองไม่เห็น เช่น
สัดส่วนประเภท event พุ่ง (DoS/flood) · จำนวน IP ต้นทางเพิ่มทันที (port scan)
· สัดส่วน AUTH_FAILURE สูง (brute force กระจายหลาย IP)

input: list ของ dict ที่มี key (อย่างน้อย): eventType, severity, sourceIp, cdeScope, createdAt
  - createdAt รับได้ทั้ง datetime, epoch (int/float), หรือ ISO-8601 string (เช่นที่ backend ส่ง)
  - key อื่นที่ขาดถือเป็นค่าว่าง/ปกติ (robust ต่อ log ที่ field ไม่ครบ)
output: list[float] เรียงตาม FEATURE_NAMES เป๊ะ
"""
from __future__ import annotations

import math
from collections import Counter
from datetime import datetime
from typing import Any, Iterable

# ลำดับ feature ตายตัว — train และ serve ต้องใช้ชุด/ลำดับเดียวกัน
# เพิ่ม/ลบ feature = ต้อง retrain model (ขนาด input เปลี่ยน)
FEATURE_NAMES: list[str] = [
    "log_count",             # จำนวน log ในชุด (ปกติ ~BATCH_SIZE)
    "distinct_source_ips",   # จำนวน IP ต้นทางไม่ซ้ำ — พุ่ง = port scan / กระจายการโจมตี
    "distinct_sources",      # จำนวน source (ชื่อ host) ไม่ซ้ำ
    "distinct_event_types",  # จำนวนประเภท event ไม่ซ้ำ
    "event_type_entropy",    # เอนโทรปีของการกระจายประเภท event (bit) — ต่ำ = กระจุกตัวผิดปกติ
    "max_event_type_share",  # สัดส่วนของประเภท event ที่มากสุด (0-1) — สูง = flood ประเภทเดียว
    "frac_auth_failure",     # สัดส่วน AUTH_FAILURE (0-1) — สูง = brute force
    "frac_high_severity",    # สัดส่วน ERROR/CRITICAL (0-1)
    "frac_cde",              # สัดส่วน log ในขอบเขตข้อมูลบัตร (0-1)
    "logs_per_second",       # อัตรา log ต่อวินาทีในช่วงของชุด — สูง = DoS/flood
]

_HIGH_SEVERITY = {"ERROR", "CRITICAL"}
_AUTH_FAILURE = "AUTH_FAILURE"


def _to_epoch(value: Any) -> float | None:
    """แปลง createdAt เป็น epoch seconds — รองรับ datetime / epoch / ISO string; คืน None ถ้าแปลงไม่ได้"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, datetime):
        return value.timestamp()
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        # ISO-8601; รองรับ 'Z' (UTC) ที่ fromisoformat รุ่นเก่าไม่รับ
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def _entropy_bits(counts: Iterable[int]) -> float:
    """เอนโทรปีแชนนอน (หน่วย bit) ของการแจกแจงนับ — 0 ถ้าเหลือประเภทเดียวหรือว่าง"""
    counts = [c for c in counts if c > 0]
    total = sum(counts)
    if total == 0:
        return 0.0
    h = 0.0
    for c in counts:
        p = c / total
        h -= p * math.log2(p)
    return h


def extract_features(logs: list[dict]) -> list[float]:
    """คำนวณ feature vector ของ batch หนึ่งชุด — คืน list[float] ยาวเท่า FEATURE_NAMES

    batch ว่าง (ไม่มี log) คืนเวกเตอร์ศูนย์ — ตัวเรียกไม่ควรส่ง batch ว่างมาอยู่แล้ว
    """
    n = len(logs)
    if n == 0:
        return [0.0] * len(FEATURE_NAMES)

    event_types = Counter()
    source_ips: set[str] = set()
    sources: set[str] = set()
    auth_failures = 0
    high_sev = 0
    cde = 0
    timestamps: list[float] = []

    for log in logs:
        et = (log.get("eventType") or "").strip()
        event_types[et] += 1
        if et == _AUTH_FAILURE:
            auth_failures += 1

        ip = log.get("sourceIp")
        if ip:
            source_ips.add(str(ip))

        src = log.get("source")
        if src:
            sources.add(str(src))

        sev = (log.get("severity") or "").strip().upper()
        if sev in _HIGH_SEVERITY:
            high_sev += 1

        if log.get("cdeScope"):
            cde += 1

        ts = _to_epoch(log.get("createdAt"))
        if ts is not None:
            timestamps.append(ts)

    max_share = max(event_types.values()) / n if event_types else 0.0

    if len(timestamps) >= 2:
        span = max(timestamps) - min(timestamps)
        logs_per_second = n / span if span > 0 else float(n)  # span 0 = burst พร้อมกัน
    else:
        logs_per_second = 0.0

    return [
        float(n),
        float(len(source_ips)),
        float(len(sources)),
        float(len(event_types)),
        _entropy_bits(event_types.values()),
        max_share,
        auth_failures / n,
        high_sev / n,
        cde / n,
        logs_per_second,
    ]


# ---- โปรไฟล์ของ feature ตอน train (ใช้อธิบายว่าทำไม batch ถูกแจ้ง) ----
# Isolation Forest บอกได้แค่ "ผิดปกติ" ไม่บอกว่าเพราะ feature ไหน · เก็บช่วง p05–p95 + มัธยฐาน
# ของ batch ที่ใช้ฝึกไว้ในไฟล์โมเดล แล้วตอน serve ชี้ feature ที่หลุดช่วงนั้นออกไปไกลที่สุด

def _percentile(sorted_values: list[float], q: float) -> float:
    """percentile แบบ linear interpolation (เหมือน numpy ค่าเริ่มต้น) · sorted_values ต้องเรียงแล้ว ไม่ว่าง"""
    pos = (len(sorted_values) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def feature_profile(rows: list[list[float]]) -> dict[str, dict[str, float]]:
    """สรุปช่วงของแต่ละ feature จาก feature vector ของ batch ที่ใช้ฝึก → {name: {p05, median, p95}}"""
    if not rows:
        raise ValueError("ต้องมี feature vector อย่างน้อย 1 แถว")
    profile: dict[str, dict[str, float]] = {}
    for i, name in enumerate(FEATURE_NAMES):
        col = sorted(r[i] for r in rows)
        profile[name] = {
            "p05": _percentile(col, 0.05),
            "median": _percentile(col, 0.5),
            "p95": _percentile(col, 0.95),
        }
    return profile


def deviations(
    features: list[float], profile: dict[str, dict[str, float]]
) -> list[tuple[str, float, float]]:
    """feature ที่อยู่นอกช่วง p05–p95 ของตอนฝึก เรียงจากหลุดไกลสุด → [(name, value, median)]

    ระยะวัดเทียบกับความกว้างของช่วง (feature ที่ตอนฝึกคงที่ เช่น frac_auth_failure = 0 ทุกชุด
    ขยับนิดเดียวก็ถือว่าหลุดมาก — ซึ่งถูก เพราะโมเดลไม่เคยเห็นค่านั้นเลย)
    """
    out: list[tuple[float, str, float, float]] = []
    for name, value in zip(FEATURE_NAMES, features):
        p = profile.get(name)
        if not p:
            continue
        if value < p["p05"]:
            gap = p["p05"] - value
        elif value > p["p95"]:
            gap = value - p["p95"]
        else:
            continue
        scale = max(p["p95"] - p["p05"], abs(p["median"]) * 0.1, 1e-6)
        out.append((gap / scale, name, value, p["median"]))
    out.sort(reverse=True)
    return [(name, value, median) for _, name, value, median in out]
