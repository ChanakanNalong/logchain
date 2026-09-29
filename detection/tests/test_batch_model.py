"""
test ของ batch_model (Isolation Forest wrapper)

- path "unavailable" (ยังไม่มีโมเดล) ต้องทำงานได้ทุกที่ แม้ไม่มี sklearn — สำคัญ
  เพราะ backend พึ่งพฤติกรรมนี้: ปิด batch ได้แม้ detection ยังไม่ได้ train
- path ที่ต้องใช้ sklearn จะ skip อัตโนมัติถ้า env ไม่มี (รันจริงในอิมเมจ detection)
"""
import tempfile
import unittest
from pathlib import Path

from app.batch_features import FEATURE_NAMES

# batch_model พึ่ง prometheus_client (เหมือน model.py เดิม) ซึ่งมีเฉพาะในอิมเมจ detection
# host ที่ไม่มี dep เหล่านี้ให้ skip ทั้งไฟล์แทนที่จะ error ตอน collect
try:
    from app.batch_model import BatchAnomalyDetector
    HAS_DEPS = True
except Exception:  # noqa: BLE001
    BatchAnomalyDetector = None  # type: ignore
    HAS_DEPS = False

try:
    import sklearn  # noqa: F401
    import joblib  # noqa: F401
    HAS_SKLEARN = HAS_DEPS
except Exception:  # noqa: BLE001
    HAS_SKLEARN = False


import random

_NORMAL_EVENTS = ["WEB_REQUEST", "FILE_ACCESS", "DB_QUERY", "API_CALL", "CACHE_HIT"]


def _normal_log(i, rng=None):
    rng = rng or random
    sev = rng.choices(["INFO", "DEBUG", "WARNING"], weights=[80, 15, 5])[0]
    return {
        "eventType": rng.choice(_NORMAL_EVENTS),
        "severity": sev,
        "sourceIp": f"10.0.{rng.randint(0, 4)}.{rng.randint(1, 60)}",
        "source": f"host-{rng.randint(1, 6)}",
        "cdeScope": False,
        "createdAt": f"2026-09-29T10:{rng.randint(0, 59):02d}:{i % 60:02d}+00:00",
    }


def _normal_batch(rng):
    """batch ปกติที่มีความแปรปรวนแบบ traffic จริง (จำนวน/IP/ประเภท event ไม่ตายตัว)"""
    n = rng.randint(60, 100)
    return [_normal_log(i, rng) for i in range(n)]


@unittest.skipUnless(HAS_DEPS, "ต้องมี prometheus_client (รันในอิมเมจ detection)")
class TestUnavailable(unittest.TestCase):
    """ไม่มีไฟล์โมเดล → unavailable, ไม่ throw, ปิด batch ได้"""

    def test_missing_model_is_unavailable(self):
        d = BatchAnomalyDetector(model_path=Path("/nonexistent/isoforest_model.joblib"))
        self.assertFalse(d.available)
        out = d.score_batch([_normal_log(i) for i in range(10)])
        self.assertFalse(out["is_anomaly"])
        self.assertFalse(out["model_available"])
        self.assertEqual(out["score"], 0.0)
        self.assertEqual(out["feature_names"], FEATURE_NAMES)
        self.assertEqual(len(out["features"]), len(FEATURE_NAMES))


@unittest.skipUnless(HAS_SKLEARN, "ต้องมี scikit-learn (รันในอิมเมจ detection)")
class TestWithModel(unittest.TestCase):
    """ฝึกโมเดลจิ๋วแล้วโหลดผ่าน wrapper — ตรวจว่า scoring ทำงานครบ path"""

    @classmethod
    def setUpClass(cls):
        from sklearn.ensemble import IsolationForest
        import joblib
        from app.batch_features import extract_features

        rng = random.Random(1234)
        normal = [_normal_batch(rng) for _ in range(120)]
        X = [extract_features(b) for b in normal]
        model = IsolationForest(n_estimators=200, contamination=0.02, random_state=0)
        model.fit(X)

        cls.tmp = tempfile.TemporaryDirectory()
        cls.path = Path(cls.tmp.name) / "isoforest_model.joblib"
        joblib.dump({"model": model, "feature_names": list(FEATURE_NAMES)}, cls.path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_loads_and_available(self):
        d = BatchAnomalyDetector(model_path=self.path)
        self.assertTrue(d.available)

    def test_normal_batch_not_flagged(self):
        d = BatchAnomalyDetector(model_path=self.path)
        out = d.score_batch(_normal_batch(random.Random(9)))
        self.assertTrue(out["model_available"])
        self.assertFalse(out["is_anomaly"])

    def test_brute_force_batch_flagged(self):
        d = BatchAnomalyDetector(model_path=self.path)
        attack = [{
            "eventType": "AUTH_FAILURE", "severity": "WARNING",
            "sourceIp": "203.0.113.9", "source": "host-a", "cdeScope": False,
            "createdAt": "2026-09-29T10:00:00+00:00",
        } for _ in range(100)]
        out = d.score_batch(attack)
        self.assertTrue(out["is_anomaly"])
        self.assertIn("Isolation Forest", out["reason"])

    def test_feature_mismatch_rejected(self):
        import joblib
        bad = self.path.parent / "bad.joblib"
        bundle = joblib.load(self.path)
        bundle["feature_names"] = ["only_one_feature"]
        joblib.dump(bundle, bad)
        d = BatchAnomalyDetector(model_path=bad)
        self.assertFalse(d.available)
        self.assertIn("retrain", d.unavailable_reason)


if __name__ == "__main__":
    unittest.main()
