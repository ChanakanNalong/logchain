"""
แปลงบรรทัดดิบ → payload ของ POST /api/v1/logs (หรือ None = ทิ้ง)

sshd: ส่งเฉพาะบรรทัดที่เป็นหลักฐานการเข้าระบบ/เดารหัส · access log: ส่งทุก request (ปกติ = INFO, เข้า filter = WARNING)
ยกเว้น IP ภายใน / EXCLUDE_IPS / health check / static asset — ทุก log ที่ส่งไปคือค่า gas (ดู docs/bench-anchor.md)
ฟิลด์ตาม src/logs/dto/create-log.dto.ts: source / sourceIp / eventType / severity / message / classification / cdeScope
"""
import ipaddress
import json
import re
from typing import Optional
from urllib.parse import unquote_plus

SSH_SOURCE = "vps-sshd"
HTTP_SOURCE = "web-proxy"
MAX_MESSAGE = 2000  # API รับได้ 10,000 — เกินนี้ไม่ใช่ log ปกติ ตัดไว้กันบรรทัดยักษ์

# ---------------------------------------------------------------- sshd

# auth.log: "Oct 15 23:47:01 host sshd[1234]: Failed password for …" → ส่วนหลัง "sshd[pid]: "
SSHD_PREFIX = re.compile(r"\bsshd(?:-session)?\[\d+\]:\s*")

# บรรทัดที่ส่ง — ลำดับไม่สำคัญ (ตรงได้แค่แบบเดียว) · ไม่ส่ง pam_unix (ซ้ำกับ Failed password ของ connection เดียวกัน)
SSHD_KEEP = [
    re.compile(r"^Invalid user \S* from (?P<ip>\S+) port \d+"),
    re.compile(r"^Failed password for (?:invalid user )?\S+ from (?P<ip>\S+) port \d+"),
    re.compile(r"^Accepted (?P<accepted>password|publickey|keyboard-interactive(?:/\S+)?) for \S+ from (?P<ip>\S+) port \d+"),
    re.compile(r"^Connection closed by (?:invalid|authenticating) user \S+ (?P<ip>\S+) port \d+"),
    re.compile(r"^Disconnected from authenticating user \S+ (?P<ip>\S+) port \d+"),
]


def _ip(raw: Optional[str]) -> Optional[str]:
    """IP ที่ API รับ (IsIP) — อย่างอื่น = None (API จะไม่ล้มทั้ง request เพราะ IP เพี้ยน)"""
    if not raw:
        return None
    try:
        return str(ipaddress.ip_address(raw.strip("[]")))
    except ValueError:
        return None


def parse_sshd(line: str) -> Optional[dict]:
    """บรรทัดจาก auth.log หรือ MESSAGE ของ journald (ไม่มี prefix) → payload หรือ None"""
    if not line:
        return None
    m = SSHD_PREFIX.search(line)
    message = (line[m.end():] if m else line).strip()
    if message.startswith("pam_unix"):
        return None
    for pat in SSHD_KEEP:
        hit = pat.match(message)
        if hit:
            return {
                "source": SSH_SOURCE,
                "sourceIp": _ip(hit.group("ip")),
                "eventType": "SSH_AUTH",
                "severity": "INFO" if hit.groupdict().get("accepted") else "WARNING",
                "message": message[:MAX_MESSAGE],
                "classification": "INTERNAL",
                "cdeScope": False,
            }
    return None


def parse_journal_json(raw: str) -> tuple[Optional[dict], Optional[str]]:
    """1 บรรทัดของ `journalctl -o json` → (payload | None, cursor | None) · JSON เสีย = (None, None)"""
    try:
        entry = json.loads(raw)
    except (ValueError, TypeError):
        return None, None
    msg = entry.get("MESSAGE")
    if isinstance(msg, list):  # journald เก็บข้อความที่ไม่ใช่ UTF-8 เป็น array ของ byte
        try:
            msg = bytes(msg).decode("utf-8", "replace")
        except (ValueError, TypeError):
            msg = None
    return (parse_sshd(msg) if isinstance(msg, str) else None), entry.get("__CURSOR")


# ---------------------------------------------------------------- nginx / Caddy access log

# nginx "combined": IP - user [time] "METHOD PATH PROTO" STATUS BYTES "REFERER" "UA" [ฟิลด์เพิ่มของ log_format เอง]
COMBINED = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[[^\]]*\] "(?P<method>[A-Z]{3,10}) (?P<path>\S+)(?: [^"]*)?" '
    r'(?P<status>\d{3}) \S+ "[^"]*" "(?P<ua>[^"]*)"(?P<rest>.*)$'
)

SCANNER_UA = re.compile(
    r"(?i)\b(sqlmap|nikto|nmap|masscan|zgrab|zmap|nuclei|gobuster|dirbuster|feroxbuster|ffuf|wpscan|"
    r"acunetix|netsparker|openvas|hydra|metasploit|burp)\b"
)
TRAVERSAL = re.compile(r"(\.\./|\.\.\\|%2e%2e(%2f|/|%5c))", re.I)
SQLI = re.compile(
    r"(?i)(union\s+(all\s+)?select|\bor\s+1\s*=\s*1\b|'\s*or\s*'|;\s*drop\s+table|\bsleep\s*\(|benchmark\s*\(|information_schema)"
)
SHELL_META = re.compile(r"(;\s*(rm|cat|wget|curl|nc|sh|bash)\b|\$\(|`|\|\s*(sh|bash)\b|&&\s*(wget|curl))", re.I)
PROBE_PATH = re.compile(
    r"(?i)^/(?:\.env\b|\.git/|wp-admin\b|wp-login\.php|xmlrpc\.php|phpmyadmin|\.aws/|\.ssh/|server-status|"
    r"cgi-bin/|vendor/phpunit|actuator\b|boaform|HNAP1)"
)
# ไฟล์ระบบที่ไม่มีเว็บแอปไหนให้บริการ — reverse proxy มัก normalize `../../etc/passwd`
# เหลือ `/etc/passwd` (ไม่มี `..` ให้ TRAVERSAL จับ) · ยิง path แบบนี้ = พยายามอ่านไฟล์ลับเสมอ
SENSITIVE_FILE = re.compile(
    r"(?i)/(?:etc/(?:passwd|shadow|gshadow|master\.passwd)|proc/self/(?:environ|cmdline)"
    r"|windows/win\.ini|winnt/win\.ini)\b"
)


# ไม่ส่ง: IP ภายใน (เราเอง / container / health check จาก docker) — ไม่ใช่ผู้โจมตีจาก internet
INTERNAL_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "127.0.0.0/8", "::1/128")]
# health check — path ตรงตัว (ไม่สน query) ไม่ส่งไม่ว่าจะมาจากไหน
HEALTH_PATHS = {"/health", "/api/v1/health", "/healthz"}
# static asset ของหน้าเว็บ (Next.js bundle / รูป / font) — 1 page view = หลายสิบบรรทัด ไม่ใช่หลักฐาน
# ตัดเฉพาะ request ที่ไม่เข้า filter (`/_next/static/../../.env` ยังส่งเป็น WARNING)
STATIC_ASSET = re.compile(
    r"(?i)^(?:/_next/(?:static/|image\b)|/favicon[^/]*$|/(?:site\.webmanifest|manifest\.json)$"
    r"|.*\.(?:js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf)$)"
)
# query ของ request ปกติที่เป็นความลับ (OIDC callback ของ Keycloak / dashboard) — log อยู่ถาวรบน chain-anchored DB
# แทนค่าด้วย *** · บรรทัด WARNING เก็บเต็ม (ค่าใน query คือตัว payload ของการโจมตี)
SECRET_QUERY = re.compile(
    r"(?i)([?&](?:code|state|session_state|nonce|token|access_token|id_token|refresh_token|client_secret|"
    r"password|code_verifier|code_challenge|key|signature)=)[^&#\s]*"
)


def parse_networks(raw: str) -> list:
    """EXCLUDE_IPS="49.48.73.182, 198.51.100.0/24" → networks · ค่าที่อ่านไม่ออกถูกข้าม"""
    nets = []
    for part in (raw or "").split(","):
        part = part.strip()
        if part:
            try:
                nets.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                pass
    return nets


def _internal(ip: Optional[str], extra=()) -> bool:
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in (*INTERNAL_NETS, *extra) if addr.version == net.version)


def _suspicious(path: str, ua: str, status: int) -> Optional[str]:
    """เหตุผลที่ส่ง (ไว้ log/เทส) · None = request ปกติ → ทิ้ง"""
    decoded = unquote_plus(path)
    if SCANNER_UA.search(ua):
        return "scanner-ua"
    if TRAVERSAL.search(path) or TRAVERSAL.search(decoded):
        return "traversal"
    if SENSITIVE_FILE.search(path) or SENSITIVE_FILE.search(decoded):
        return "sensitive-file"
    if SQLI.search(decoded):
        return "sqli"
    if SHELL_META.search(decoded):
        return "shell-meta"
    if PROBE_PATH.search(decoded) and status >= 400:
        return "probe-path"
    return None


def parse_ua_list(raw: str) -> tuple:
    """HTTP_EXCLUDE_UA="Uptime-Kuma, Pingdom" → ("uptime-kuma", "pingdom") · เทียบแบบ substring ไม่สนตัวพิมพ์"""
    return tuple(p.strip().lower() for p in (raw or "").split(",") if p.strip())


def _http_payload(ip, method, path, status, ua, trust_cf, cf_ip, exclude=(), all_requests=True,
                  exclude_ua=()) -> Optional[dict]:
    try:
        code = int(status)
    except (TypeError, ValueError):
        return None
    path = path or "/"
    client = (_ip(cf_ip) if (trust_cf and cf_ip) else None) or _ip(ip)
    bare = path.split("?", 1)[0]
    if _internal(client, exclude) or bare in HEALTH_PATHS:
        return None
    suspicious = _suspicious(path, ua or "", code)
    if not suspicious:
        if not all_requests or STATIC_ASSET.match(bare):
            return None
        # monitor ภายนอก (Uptime Kuma ยิง GET / ทุกนาที) = health check · ปลอม UA แล้วโจมตีก็ยังเข้า filter ข้างบน
        if exclude_ua and any(m in (ua or "").lower() for m in exclude_ua):
            return None
        path = SECRET_QUERY.sub(r"\1***", path)
    message = f'{method} {path} {code} "{ua or "-"}"'
    return {
        "source": HTTP_SOURCE,
        "sourceIp": client,
        "eventType": "HTTP_ACCESS",
        "severity": "WARNING" if suspicious else "INFO",
        "message": message[:MAX_MESSAGE],
        "classification": "INTERNAL",
        "cdeScope": False,
    }


def parse_access(line: str, trust_cf: bool = False, exclude=(), all_requests: bool = True,
                 exclude_ua=()) -> Optional[dict]:
    """
    nginx combined (ถ้า log_format ต่อท้ายด้วย "<CF-Connecting-IP>" ให้เปิด trust_cf)
    หรือ Caddy JSON (`log { format json }`) — แยกจากตัวอักษรแรก
    Caddy: ใช้ request.client_ip (IP จริงหลัง trusted_proxies ของ Caddy) — https-proxy บน CT141 ใช้แบบนี้ (trust_cf=False)
    all_requests=False = แบบเดิม: ส่งเฉพาะที่เข้า filter (HTTP_ALL_REQUESTS=false)
    exclude_ua = UA ของ monitor (parse_ua_list) — ตัดเฉพาะ request ปกติ
    """
    if not line:
        return None
    line = line.strip()
    if line.startswith("{"):
        return _parse_caddy(line, trust_cf, exclude, all_requests, exclude_ua)
    m = COMBINED.match(line)
    if not m:
        return None
    cf_ip = None
    if trust_cf:
        extra = re.findall(r'"([^"]*)"', m.group("rest") or "")
        cf_ip = extra[-1] if extra else None
    return _http_payload(m.group("ip"), m.group("method"), m.group("path"), m.group("status"),
                         m.group("ua"), trust_cf, cf_ip, exclude, all_requests, exclude_ua)


def _parse_caddy(line: str, trust_cf: bool, exclude=(), all_requests: bool = True, exclude_ua=()) -> Optional[dict]:
    try:
        e = json.loads(line)
        req = e.get("request") or {}
        headers = req.get("headers") or {}
        first = lambda k: (headers.get(k) or [None])[0]  # noqa: E731 — header ของ Caddy เป็น list
        ip = req.get("client_ip") or req.get("remote_ip")
        return _http_payload(ip, req.get("method"), req.get("uri") or "/", e.get("status"),
                             first("User-Agent"), trust_cf, first("Cf-Connecting-Ip"), exclude, all_requests,
                             exclude_ua)
    except (ValueError, TypeError, AttributeError):
        return None


def is_cors_preflight(payload: Optional[dict]) -> bool:
    """
    CORS preflight = web-proxy OPTIONS ที่ตอบ 2xx และเป็น request ปกติ (severity INFO)
    — browser ยิงก่อน request จริงทุกครั้ง ไม่ใช่หลักฐานอะไร → ตัดทิ้งเพื่อลด log/ค่า gas
    OPTIONS ที่ไม่ใช่ 2xx (เช่น 403 โดน CORS block) หรือเข้า filter (WARNING) ไม่ใช่ preflight → ส่งตามเดิม
    อ่าน method/status จาก message ที่ _http_payload สร้างเอง: '<METHOD> <path> <code> "<ua>"' (path ไม่มีช่องว่าง)
    """
    if not payload or payload.get("source") != HTTP_SOURCE or payload.get("severity") != "INFO":
        return False
    parts = (payload.get("message") or "").split(" ", 2)
    if len(parts) < 3 or parts[0] != "OPTIONS":
        return False
    code = parts[2].split(" ", 1)[0]
    return code.isdigit() and 200 <= int(code) < 300
