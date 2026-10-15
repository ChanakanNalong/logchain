"""
LogChain forwarder — อ่าน sshd (journald หรือ auth.log) + access log ของ nginx/Caddy แล้วส่ง POST /api/v1/logs

ออกแบบให้ "ไม่ตายและไม่เผาเงิน":
- บรรทัดเสีย / parse ไม่ได้ = ข้าม ไม่ทำให้ loop ตาย
- rate cap (ค่าเริ่มต้น 300/ชม. แบบหน้าต่างเลื่อน) + dedup ช่วงสั้น — เกิน = ทิ้ง (นับไว้ log สรุปทุก 10 นาที)
  ทุก log ที่ส่งคือส่วนหนึ่งของ tx บน chain (docs/bench-anchor.md)
- API ล่ม = backoff แบบ exponential · คิวในหน่วยความจำมีเพดาน = cap → ดับนานแค่ไหนก็ไม่ส่ง backlog เกิน cap
- cursor ของ journald / offset ของไฟล์ เก็บลงไฟล์ state (เขียนแบบ atomic) — restart แล้วอ่านต่อจากเดิม
  บันทึกหลังรับเข้าคิว: process ตายระหว่างคิวยังไม่ส่ง = log ช่วงนั้นหาย (at-most-once — ไม่ส่งซ้ำ)
- เวลาของ log = เวลาที่ backend รับ (API ไม่รับ createdAt จาก client) ไม่ใช่เวลาที่เกิดบน VPS
"""
import argparse
import collections
import hashlib
import json
import logging
import os
import signal
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable, Optional

from .parsers import parse_access, parse_journal_json, parse_networks, parse_sshd

log = logging.getLogger("logchain-forwarder")

DEFAULTS = {
    "LOGCHAIN_API_URL": "",
    "LOGCHAIN_TOKEN_URL": "",
    "LOGCHAIN_CLIENT_ID": "vps-forwarder",
    "LOGCHAIN_CLIENT_SECRET": "",
    "LOGCHAIN_CA_FILE": "",
    "SSH_ENABLED": "true",
    "SSH_MODE": "journal",  # journal | file
    "SSH_JOURNAL_ARGS": "-u ssh",
    "SSH_AUTH_LOG": "/var/log/auth.log",
    "ACCESS_LOGS": "",  # comma-separated paths
    "TRUST_CF_CONNECTING_IP": "false",
    # IP/CIDR ของเราเอง (เช่น IP ขาออกของเครื่อง) ที่ไม่ส่งจาก access log · IP ภายในตัดให้เสมออยู่แล้ว
    "EXCLUDE_IPS": "",
    "RATE_PER_HOUR": "300",
    "DEDUP_SECONDS": "10",
    "SUMMARY_SECONDS": "600",
    "STATE_FILE": "/var/lib/logchain-forwarder/state.json",
    "DRY_RUN": "false",
}


def load_config(path: str) -> dict:
    """KEY=VALUE (บรรทัด # = comment · ค่าใส่ quote ได้) ทับ DEFAULTS · env ของ process ทับไฟล์"""
    cfg = dict(DEFAULTS)
    if path and os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip("'\"")
    for k in DEFAULTS:
        if k in os.environ:
            cfg[k] = os.environ[k]
    return cfg


def truthy(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------- rate cap + dedup + counters


class Gate:
    """ด่านก่อนเข้าคิว — rate cap แบบหน้าต่างเลื่อน 1 ชม. + dedup ข้อความซ้ำช่วงสั้น + ตัวนับที่ทิ้ง"""

    def __init__(self, per_hour: int, dedup_seconds: float, clock: Callable[[], float] = time.monotonic):
        self.per_hour = per_hour
        self.dedup_seconds = dedup_seconds
        self.clock = clock
        self.sent = collections.deque()  # เวลาที่ปล่อยผ่านในชั่วโมงล่าสุด
        self.recent: dict = {}  # key → เวลาเห็นล่าสุด
        self.counts = collections.Counter()

    def admit(self, payload: dict) -> bool:
        now = self.clock()
        key = hashlib.sha256(f'{payload.get("source")}|{payload.get("message")}'.encode()).hexdigest()
        last = self.recent.get(key)
        self.recent[key] = now
        if len(self.recent) > 5000:  # กันโตไม่หยุด
            cutoff = now - self.dedup_seconds
            self.recent = {k: t for k, t in self.recent.items() if t >= cutoff}
        if last is not None and now - last < self.dedup_seconds:
            self.counts["dropped_dedup"] += 1
            return False
        while self.sent and now - self.sent[0] >= 3600:
            self.sent.popleft()
        if len(self.sent) >= self.per_hour:
            self.counts["dropped_rate_cap"] += 1
            return False
        self.sent.append(now)
        self.counts["admitted"] += 1
        return True


# ---------------------------------------------------------------- API client


class ApiClient:
    """POST /logs ด้วย client_credentials · token cache ต่ออายุก่อนหมด 60 วิ · 401 = ขอใหม่ 1 ครั้ง"""

    def __init__(self, cfg: dict, opener: Optional[Callable] = None, clock: Callable[[], float] = time.time):
        self.api = cfg["LOGCHAIN_API_URL"].rstrip("/")
        self.token_url = cfg["LOGCHAIN_TOKEN_URL"]
        self.client_id = cfg["LOGCHAIN_CLIENT_ID"]
        self.secret = cfg["LOGCHAIN_CLIENT_SECRET"]
        ctx = ssl.create_default_context(cafile=cfg["LOGCHAIN_CA_FILE"] or None)
        self.open = opener or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout, context=ctx))
        self.clock = clock
        self._token: Optional[str] = None
        self._expires = 0.0

    def token(self, force: bool = False) -> str:
        if not force and self._token and self.clock() < self._expires - 60:
            return self._token
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.secret,
        }).encode()
        req = urllib.request.Request(self.token_url, data=body, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with self.open(req, timeout=15) as res:
            data = json.loads(res.read())
        self._token = data["access_token"]
        self._expires = self.clock() + float(data.get("expires_in", 300))
        return self._token

    def send(self, payload: dict) -> None:
        """สำเร็จ = return · 4xx อื่น (payload เสีย) = ValueError (ทิ้ง) · ล่ม/5xx/เครือข่าย = OSError (retry)"""
        for attempt in (0, 1):
            req = urllib.request.Request(
                f"{self.api}/logs", data=json.dumps(payload).encode(), method="POST",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token(force=attempt == 1)}"},
            )
            try:
                with self.open(req, timeout=15):
                    return
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 0:
                    continue
                if 400 <= e.code < 500 and e.code not in (401, 408, 429):
                    raise ValueError(f"API rejected log: HTTP {e.code}") from e
                raise OSError(f"API HTTP {e.code}") from e


# ---------------------------------------------------------------- state


class State:
    """cursor / offset ต่อ source — เขียนไฟล์ใหม่แล้ว rename (ไฟล์ไม่มีทางเหลือครึ่งเดียว)"""

    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        try:
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            self.data = {}

    def get(self, key: str, default=None):
        with self.lock:
            return self.data.get(key, default)

    def set(self, key: str, value) -> None:
        with self.lock:
            self.data[key] = value
            d = os.path.dirname(self.path) or "."
            os.makedirs(d, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".state-")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.path)


# ---------------------------------------------------------------- sources


def follow_file(path: str, state: State, stop: threading.Event, on_line: Callable[[str], None], poll: float = 1.0):
    """
    tail -F ที่จำ offset: เปิดใหม่เมื่อ inode เปลี่ยน (logrotate ย้ายไฟล์) หรือไฟล์สั้นลง (copytruncate)
    ก่อนสลับไฟล์ อ่านไฟล์เดิมที่เปิดค้างอยู่ให้หมดก่อน · ครั้งแรกที่เห็นไฟล์ = เริ่มที่ท้ายไฟล์ (ไม่ส่งของเก่า)
    """
    key = f"file:{path}"
    saved = state.get(key) or {}
    f = None
    inode = None
    while not stop.is_set():
        try:
            if f is None:
                st = os.stat(path)
                f = open(path, "r", encoding="utf-8", errors="replace")
                inode = st.st_ino
                if saved.get("inode") == inode and saved.get("offset", 0) <= st.st_size:
                    f.seek(saved["offset"])
                elif saved:  # ไฟล์ใหม่ (rotate ระหว่างที่ปิดอยู่) → อ่านตั้งแต่ต้น
                    f.seek(0)
                else:
                    f.seek(0, os.SEEK_END)
            while True:
                line = f.readline()
                if not line or not line.endswith("\n"):
                    if line:  # บรรทัดยังเขียนไม่จบ — ถอยกลับไปรอ
                        f.seek(f.tell() - len(line.encode("utf-8", "replace")))
                    break
                try:
                    on_line(line.rstrip("\n"))
                except Exception:  # noqa: BLE001 — บรรทัดเดียวพังต้องไม่ทำให้ loop ตาย
                    log.exception("line handler failed — skipped")
            saved = {"inode": inode, "offset": f.tell()}
            state.set(key, saved)
            try:
                st = os.stat(path)
                if st.st_ino != inode or st.st_size < f.tell():
                    f.close()
                    f = None
                    saved = {"inode": None, "offset": 0}  # ไฟล์ใหม่ อ่านจากต้น
                    continue
            except FileNotFoundError:
                pass  # rotate แล้วยังไม่มีไฟล์ใหม่ — อ่านตัวเก่าต่อไปก่อน
        except FileNotFoundError:
            pass
        except OSError:
            log.exception("cannot read %s — retrying", path)
            f = None
        stop.wait(poll)
    if f is not None:
        f.close()


def follow_journal(args: str, state: State, stop: threading.Event, on_payload: Callable[[dict], None],
                   journalctl: str = "journalctl"):
    """
    journalctl <args> -f -o json ต่อจาก cursor ที่จำไว้ (ไม่มี = เริ่มจากตอนนี้ -n 0) · process ตาย = เปิดใหม่
    cursor ของบรรทัดที่ส่งเข้าคิว บันทึกทันที (ไม่งั้น restart แล้วส่งบรรทัดท้าย ๆ ซ้ำ — เจอจริงตอนเทส e2e)
    บรรทัดที่ถูกข้าม (sshd log อื่น) บันทึกห่างกันอย่างน้อย 1 วิ ไม่ให้เขียนไฟล์ทุกบรรทัด
    """
    while not stop.is_set():
        cursor = state.get("journal:cursor")
        cmd = [journalctl, *args.split(), "-f", "-o", "json", "--no-pager"]
        cmd += [f"--after-cursor={cursor}"] if cursor else ["-n", "0"]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True, errors="replace")
        except OSError:
            log.exception("cannot start journalctl — retrying in 10s")
            stop.wait(10)
            continue
        last_save = 0.0
        for raw in proc.stdout:
            if stop.is_set():
                break
            payload = cur = None
            try:
                payload, cur = parse_journal_json(raw)
                if payload:
                    on_payload(payload)
            except Exception:  # noqa: BLE001
                log.exception("journal line failed — skipped")
            if cur and (payload or time.monotonic() - last_save > 1):
                state.set("journal:cursor", cur)
                last_save = time.monotonic()
        proc.terminate()
        proc.stdout.close()
        if not stop.is_set():
            log.warning("journalctl exited (%s) — restarting in 5s", proc.wait())
            stop.wait(5)


# ---------------------------------------------------------------- sender


class Sender:
    """คิวมีเพดาน + ส่งทีละตัว + backoff เมื่อ API ล่ม (1, 2, 4 … สูงสุด 300 วิ)"""

    def __init__(self, client, gate: Gate, max_queue: int, dry_run: bool = False,
                 sleep: Callable[[float], None] = time.sleep):
        self.client = client
        self.gate = gate
        self.queue: collections.deque = collections.deque()
        self.max_queue = max_queue
        self.dry_run = dry_run
        self.sleep = sleep
        self.cond = threading.Condition()
        self.backoff = 0.0

    def offer(self, payload: dict) -> None:
        if not self.gate.admit(payload):
            return
        with self.cond:
            if len(self.queue) >= self.max_queue:
                self.queue.popleft()  # ทิ้งตัวเก่าสุด — ของใหม่สำคัญกว่าตอนกำลังถูกโจมตี
                self.gate.counts["dropped_queue_full"] += 1
            self.queue.append(payload)
            self.cond.notify()

    def step(self, timeout: float = 1.0) -> bool:
        """ส่ง 1 ตัวถ้ามี · คืน True ถ้าทำอะไรไป (ใช้ในเทส)"""
        with self.cond:
            if not self.queue:
                self.cond.wait(timeout)
                if not self.queue:
                    return False
            payload = self.queue[0]
        try:
            if self.dry_run:
                print(json.dumps(payload, ensure_ascii=False), flush=True)
            else:
                self.client.send(payload)
            self.gate.counts["sent"] += 1
            self.backoff = 0.0
        except ValueError as e:
            self.gate.counts["dropped_rejected"] += 1
            log.warning("%s — dropped", e)
        except Exception as e:  # noqa: BLE001 — เครือข่าย / API ล่ม → เก็บไว้ในคิว แล้วรอ
            self.gate.counts["send_errors"] += 1
            self.backoff = min(max(self.backoff * 2, 1.0), 300.0)
            log.warning("send failed (%s) — backoff %.0fs, queue %d", e, self.backoff, len(self.queue))
            self.sleep(self.backoff)
            return True
        with self.cond:
            if self.queue and self.queue[0] is payload:
                self.queue.popleft()
        return True


# ---------------------------------------------------------------- main


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="LogChain VPS log forwarder")
    ap.add_argument("--config", default=os.environ.get("LOGCHAIN_FORWARDER_ENV", "/etc/logchain-forwarder.env"))
    ap.add_argument("--dry-run", action="store_true", help="พิมพ์ payload แทนการส่ง")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cfg = load_config(a.config)
    dry = a.dry_run or truthy(cfg["DRY_RUN"])
    if not dry and not (cfg["LOGCHAIN_API_URL"] and cfg["LOGCHAIN_TOKEN_URL"] and cfg["LOGCHAIN_CLIENT_SECRET"]):
        log.error("LOGCHAIN_API_URL / LOGCHAIN_TOKEN_URL / LOGCHAIN_CLIENT_SECRET required (%s)", a.config)
        return 2

    per_hour = int(cfg["RATE_PER_HOUR"])
    gate = Gate(per_hour, float(cfg["DEDUP_SECONDS"]))
    sender = Sender(None if dry else ApiClient(cfg), gate, max_queue=per_hour, dry_run=dry)
    state = State(cfg["STATE_FILE"])
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())

    threads = []
    if truthy(cfg["SSH_ENABLED"]):
        if cfg["SSH_MODE"] == "file":
            def on_ssh(line):
                p = parse_sshd(line)
                if p:
                    sender.offer(p)
            threads.append(threading.Thread(target=follow_file, args=(cfg["SSH_AUTH_LOG"], state, stop, on_ssh), daemon=True))
        else:
            threads.append(threading.Thread(target=follow_journal, args=(cfg["SSH_JOURNAL_ARGS"], state, stop, sender.offer), daemon=True))
    trust_cf = truthy(cfg["TRUST_CF_CONNECTING_IP"])
    exclude = parse_networks(cfg["EXCLUDE_IPS"])
    for path in filter(None, (p.strip() for p in cfg["ACCESS_LOGS"].split(","))):
        def on_http(line, _cf=trust_cf, _ex=exclude):
            p = parse_access(line, _cf, _ex)
            if p:
                sender.offer(p)
        threads.append(threading.Thread(target=follow_file, args=(path, state, stop, on_http), daemon=True))
    if not threads:
        log.error("nothing to read — enable SSH_ENABLED or set ACCESS_LOGS")
        return 2
    for t in threads:
        t.start()

    summary_every = float(cfg["SUMMARY_SECONDS"])
    last_summary = time.monotonic()
    log.info("forwarder started: %d source(s), cap %d/h, dry_run=%s", len(threads), per_hour, dry)
    while not stop.is_set():
        sender.step(timeout=1.0)
        if time.monotonic() - last_summary >= summary_every:
            log.info("summary (last %.0fs): %s · queue %d", summary_every, dict(gate.counts), len(sender.queue))
            gate.counts.clear()
            last_summary = time.monotonic()
    log.info("stopping — final counts %s · %d queued log(s) not sent", dict(gate.counts), len(sender.queue))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
