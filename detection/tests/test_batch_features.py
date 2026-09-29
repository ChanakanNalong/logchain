"""
test ของ batch_features — บริสุทธิ์ ไม่พึ่ง numpy/sklearn จึงรันบน host ได้เลย
(discover -s tests) · ครอบ feature ที่เป็นสัญญาณของแต่ละการโจมตี
"""
import unittest

from app.batch_features import FEATURE_NAMES, extract_features


def _f(name):
    return FEATURE_NAMES.index(name)


def _log(event_type="WEB_REQUEST", severity="INFO", ip="10.0.0.1",
         source="host-a", cde=False, ts="2026-09-29T10:00:00+00:00"):
    return {
        "eventType": event_type,
        "severity": severity,
        "sourceIp": ip,
        "source": source,
        "cdeScope": cde,
        "createdAt": ts,
    }


class TestExtractFeatures(unittest.TestCase):
    def test_vector_length_matches_feature_names(self):
        v = extract_features([_log()])
        self.assertEqual(len(v), len(FEATURE_NAMES))

    def test_empty_batch_is_zero_vector(self):
        self.assertEqual(extract_features([]), [0.0] * len(FEATURE_NAMES))

    def test_log_count(self):
        v = extract_features([_log() for _ in range(7)])
        self.assertEqual(v[_f("log_count")], 7.0)

    def test_normal_batch_low_signal(self):
        # traffic ปกติ: หลายประเภท event, หลาย IP, severity ต่ำ
        logs = []
        for i in range(20):
            logs.append(_log(
                event_type=["WEB_REQUEST", "FILE_ACCESS", "DB_QUERY"][i % 3],
                ip=f"10.0.0.{i}",
            ))
        v = extract_features(logs)
        self.assertEqual(v[_f("frac_auth_failure")], 0.0)
        self.assertEqual(v[_f("frac_high_severity")], 0.0)
        self.assertGreater(v[_f("event_type_entropy")], 1.0)   # กระจายหลายประเภท
        self.assertLess(v[_f("max_event_type_share")], 0.5)

    def test_brute_force_high_auth_failure(self):
        logs = [_log(event_type="AUTH_FAILURE", severity="WARNING", ip="203.0.113.5")
                for _ in range(30)]
        v = extract_features(logs)
        self.assertEqual(v[_f("frac_auth_failure")], 1.0)
        self.assertEqual(v[_f("max_event_type_share")], 1.0)
        self.assertEqual(v[_f("event_type_entropy")], 0.0)     # ประเภทเดียว

    def test_port_scan_many_distinct_ips(self):
        logs = [_log(event_type="CONN_ATTEMPT", ip=f"198.51.100.{i}") for i in range(50)]
        v = extract_features(logs)
        self.assertEqual(v[_f("distinct_source_ips")], 50.0)

    def test_high_severity_fraction(self):
        logs = [_log(severity="CRITICAL") for _ in range(4)] + \
               [_log(severity="INFO") for _ in range(6)]
        v = extract_features(logs)
        self.assertAlmostEqual(v[_f("frac_high_severity")], 0.4)

    def test_cde_fraction(self):
        logs = [_log(cde=True) for _ in range(3)] + [_log(cde=False) for _ in range(1)]
        v = extract_features(logs)
        self.assertAlmostEqual(v[_f("frac_cde")], 0.75)

    def test_logs_per_second_rate(self):
        # 11 log กระจายใน 10 วินาที → ~1.1 log/s
        logs = [_log(ts=f"2026-09-29T10:00:{s:02d}+00:00") for s in range(11)]
        v = extract_features(logs)
        self.assertAlmostEqual(v[_f("logs_per_second")], 11 / 10, places=6)

    def test_logs_per_second_burst_same_timestamp(self):
        logs = [_log(ts="2026-09-29T10:00:00+00:00") for _ in range(40)]
        v = extract_features(logs)
        self.assertEqual(v[_f("logs_per_second")], 40.0)   # span 0 = burst → คืนจำนวน log

    def test_createdat_accepts_epoch_and_datetime(self):
        from datetime import datetime, timezone
        base = datetime(2026, 9, 29, 10, 0, 0, tzinfo=timezone.utc)
        logs = [
            _log(ts=base.timestamp()),
            _log(ts=base.timestamp() + 5),
            _log(ts=datetime(2026, 9, 29, 10, 0, 10, tzinfo=timezone.utc)),
        ]
        v = extract_features(logs)
        self.assertAlmostEqual(v[_f("logs_per_second")], 3 / 10, places=6)

    def test_missing_fields_are_robust(self):
        # log ที่ field ไม่ครบต้องไม่ทำให้ crash
        v = extract_features([{"eventType": "X"}, {}])
        self.assertEqual(v[_f("log_count")], 2.0)
        self.assertEqual(v[_f("distinct_source_ips")], 0.0)
        self.assertEqual(v[_f("logs_per_second")], 0.0)


if __name__ == "__main__":
    unittest.main()
