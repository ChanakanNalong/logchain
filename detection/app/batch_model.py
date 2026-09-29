"""
batch_model.py — Isolation Forest สำหรับจำแนก batch ว่าผิดปกติไหม (ตรวจจับระดับที่ 3)

โหลดโมเดลที่ train แล้วจาก data/isoforest_model.joblib (สร้างด้วย train_isoforest.py)
แล้ว score feature vector ของ batch · เป็น unsupervised: train บน batch "ปกติ" อย่างเดียว
batch ที่อยู่ห่างจากกลุ่มปกติ (isolate ได้ด้วยการแบ่งน้อยครั้ง) ถือว่าผิดปกติ

**graceful degradation โดยตั้งใจ:** ถ้าไม่มีไฟล์โมเดล หรือ import sklearn/joblib ไม่ได้
detector จะอยู่สถานะ unavailable แล้ว score_batch คืน is_anomaly=False + available=False
เพื่อให้ endpoint และ backend (ตอนปิด batch) ไม่ล้มเมื่อยังไม่ได้ train — การปิด batch
เป็นแกน integrity ห้ามพังเพราะ detection (ระดับที่ 3 เป็นส่วนเสริม ไม่ใช่ gate)

import sklearn แบบ lazy (ในเมธอด) โมดูลนี้จึง import ได้แม้ env ไม่มี sklearn
"""
from __future__ import annotations

from pathlib import Path

from prometheus_client import Counter

from app.batch_features import FEATURE_NAMES, extract_features

ISOFOREST_ANOMALY = Counter(
    "isoforest_anomaly_total",
    "Total batches flagged anomalous by Isolation Forest",
)
ISOFOREST_SCORED = Counter(
    "isoforest_scored_total",
    "Total batches scored by Isolation Forest",
    ["result"],  # anomaly / normal / unavailable
)

MODEL_PATH = Path(__file__).parent.parent / "data" / "isoforest_model.joblib"


class BatchAnomalyDetector:
    """โหลดโมเดลครั้งเดียวตอน service start · unavailable ถ้าโหลดไม่ได้ (ไม่ throw)"""

    def __init__(self, model_path: Path = MODEL_PATH):
        self.model = None
        self.feature_names: list[str] = FEATURE_NAMES
        self.unavailable_reason: str | None = None
        self._load(model_path)

    def _load(self, model_path: Path) -> None:
        if not model_path.exists():
            self.unavailable_reason = f"ยังไม่มีไฟล์โมเดล ({model_path.name}) — ต้อง train ก่อน"
            return
        try:
            import joblib  # lazy — env ที่ไม่มี sklearn ยัง import โมดูลนี้ได้

            bundle = joblib.load(model_path)
            self.model = bundle["model"]
            saved_features = bundle.get("feature_names", FEATURE_NAMES)
            if list(saved_features) != list(FEATURE_NAMES):
                # โมเดล train ด้วยชุด feature คนละชุด → ใช้ต่อไม่ได้ (ขนาด/ความหมายไม่ตรง)
                self.model = None
                self.unavailable_reason = "feature ของโมเดลไม่ตรงกับโค้ดปัจจุบัน — ต้อง retrain"
                return
            self.feature_names = list(saved_features)
        except Exception as e:  # noqa: BLE001 — โหลดพังต้องไม่ทำให้ service ล้ม
            self.model = None
            self.unavailable_reason = f"โหลดโมเดลไม่สำเร็จ: {e}"

    @property
    def available(self) -> bool:
        return self.model is not None

    def score_batch(self, logs: list[dict]) -> dict:
        """คำนวณ feature จาก log ของ batch แล้ว score · คืน dict ตรงกับ BatchDetectResponse"""
        features = extract_features(logs)
        return self._score_features(features)

    def _score_features(self, features: list[float]) -> dict:
        base = {
            "features": features,
            "feature_names": self.feature_names,
        }
        if not self.available:
            ISOFOREST_SCORED.labels(result="unavailable").inc()
            return {
                **base,
                "is_anomaly": False,
                "score": 0.0,
                "model_available": False,
                "reason": self.unavailable_reason or "model unavailable",
            }

        # decision_function: ยิ่งต่ำ (ติดลบ) ยิ่งผิดปกติ · predict: -1 = anomaly, 1 = normal
        X = [features]
        score = float(self.model.decision_function(X)[0])
        is_anomaly = int(self.model.predict(X)[0]) == -1

        ISOFOREST_SCORED.labels(result="anomaly" if is_anomaly else "normal").inc()
        if is_anomaly:
            ISOFOREST_ANOMALY.inc()
            reason = self._explain(features)
        else:
            reason = "อยู่ในกลุ่มปกติของ batch ที่ใช้ฝึก"

        return {
            **base,
            "is_anomaly": is_anomaly,
            "score": score,
            "model_available": True,
            "reason": reason,
        }

    def _explain(self, features: list[float]) -> str:
        """สรุปสั้น ๆ ว่า feature ตัวไหนเด่น เพื่อให้ผู้ดูแลเข้าใจว่าทำไมถูกแจ้ง"""
        fmap = dict(zip(self.feature_names, features))
        signals = []
        if fmap.get("frac_auth_failure", 0) >= 0.3:
            signals.append(f"AUTH_FAILURE สูง ({fmap['frac_auth_failure']:.0%})")
        if fmap.get("max_event_type_share", 0) >= 0.8:
            signals.append(f"event ประเภทเดียวครอง ({fmap['max_event_type_share']:.0%})")
        if fmap.get("frac_high_severity", 0) >= 0.3:
            signals.append(f"severity สูงเยอะ ({fmap['frac_high_severity']:.0%})")
        if fmap.get("distinct_source_ips", 0) >= 30:
            signals.append(f"IP ต้นทางหลากหลาย ({int(fmap['distinct_source_ips'])} IP)")
        head = "batch ผิดปกติ (Isolation Forest)"
        return f"{head}: {' · '.join(signals)}" if signals else head


# singleton
_batch_detector: BatchAnomalyDetector | None = None


def get_batch_detector() -> BatchAnomalyDetector:
    global _batch_detector
    if _batch_detector is None:
        _batch_detector = BatchAnomalyDetector()
    return _batch_detector
