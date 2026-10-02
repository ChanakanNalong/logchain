#!/usr/bin/env python3
"""ตรวจสิทธิ์ของ role จริงบน stack ที่รันอยู่ — token จริงจาก Keycloak × ทุก endpoint ที่ต้อง login

login user ทดสอบของ scripts/seed-test-users.sh (analyst/operator/auditor/ingestor-user) แบบเบราว์เซอร์
(authorization code + PKCE ผ่าน client logchain-frontend) แล้วยิงทุก endpoint เทียบกับตาราง ALLOWED ด้านล่าง
ซึ่งต้องตรงกับ @Roles ในโค้ด และกับ src/auth/rbac-matrix.spec.ts (เทสต์ระดับ unit ของเรื่องเดียวกัน)

ไม่แก้ข้อมูลในระบบ: endpoint ที่เขียนได้ส่ง body ผิดรูป / UUID ที่ไม่มีจริง — guard รันก่อน pipe/handler
ได้ 403 = ถูกบล็อก · อย่างอื่น (200/400/404) = ผ่าน guard · admin-user ไม่อยู่ในชุดนี้ (ต้องใช้ TOTP)

ใช้:  python3 scripts/check-rbac-live.py            ← ต้องรัน ./scripts/seed-test-users.sh มาก่อน
      API=… KC=… CA=… python3 scripts/check-rbac-live.py
exit 0 = ตรงทุกช่อง · 1 = มีช่องที่ไม่ตรง
"""
import base64
import hashlib
import html
import http.cookiejar
import json
import os
import re
import secrets
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = {}
for line in (ROOT / ".env").read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        ENV[k.strip()] = v.strip().strip("'\"")  # key ซ้ำ: บรรทัดหลังชนะ เหมือน docker compose

KC = os.environ.get("KC", ENV.get("KEYCLOAK_URL", "https://localhost:8443")).rstrip("/")
OIDC = f"{KC}/realms/logchain/protocol/openid-connect"
API = os.environ.get("API", "http://localhost:3000/api/v1").rstrip("/")
REDIRECT = os.environ.get("DASHBOARD_PUBLIC_URL", "https://localhost:3453").rstrip("/") + "/"
CA = os.environ.get("CA", str(ROOT / "infra/tls/certs/ca.crt"))
CTX = ssl.create_default_context(cafile=CA if Path(CA).exists() else None)

UUID = "11111111-1111-4111-8111-111111111111"
ROLES = ["analyst", "operator", "auditor", "ingestor"]
APP_ROLES = {"admin", "analyst", "operator", "auditor", "ingestor"}
READERS = {"admin", "analyst", "operator"}
# method, path, body, role ที่ต้องผ่าน — ตรงกับ @Roles ของแต่ละ controller
ALLOWED = [
    ("POST", "/logs", {}, {"admin", "ingestor"}),
    ("GET", "/logs", None, READERS),
    ("GET", f"/logs/{UUID}", None, READERS),
    ("POST", "/alerts", {}, {"admin"}),
    ("GET", "/alerts", None, READERS),
    ("PATCH", f"/alerts/{UUID}/resolve", None, {"admin", "operator"}),
    ("POST", "/logs/verify-now", None, {"admin"}),
    ("POST", "/logs/seal-now", None, {"admin"}),
    ("GET", f"/logs/{UUID}/proof", None, READERS),
    ("GET", "/batches", None, READERS | {"auditor"}),
    ("GET", "/stats/overview", None, READERS),
    ("GET", "/stats/traffic", None, READERS),
    ("GET", "/compliance/reports", None, {"admin", "auditor"}),
    ("DELETE", "/erasure/user/nobody-rbac-check", None, {"admin"}),
    ("GET", "/admin/users", None, {"admin"}),
    ("GET", "/admin/roles", None, {"admin"}),
    ("POST", f"/admin/users/{UUID}/roles", {"role": "analyst"}, {"admin"}),
    ("DELETE", f"/admin/users/{UUID}/roles/analyst", None, {"admin"}),
    ("PATCH", f"/admin/users/{UUID}", {"enabled": True}, {"admin"}),
]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def login(username: str, password: str) -> str:
    """auth code + PKCE แบบที่ dashboard ทำ · คืน access token"""
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=CTX),
        _NoRedirect,
    )
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    query = urllib.parse.urlencode({
        "client_id": "logchain-frontend", "response_type": "code", "scope": "openid",
        "redirect_uri": REDIRECT, "code_challenge": challenge, "code_challenge_method": "S256",
        "state": secrets.token_urlsafe(8), "prompt": "login",
    })
    page = opener.open(f"{OIDC}/auth?{query}").read().decode()
    form = re.search(r'action="([^"]+)"', page)
    if not form:
        raise RuntimeError("ไม่เจอฟอร์ม login ของ Keycloak")
    try:
        body = opener.open(html.unescape(form.group(1)),
                           urllib.parse.urlencode({"username": username, "password": password}).encode()).read().decode()
        title = re.search(r"<title>(.*?)</title>", body, re.S)
        raise RuntimeError(f"login {username} ไม่ผ่าน (รหัสผิด / ต้องตั้ง OTP / required action ค้าง): "
                           f"{title.group(1).strip() if title else '?'}")
    except urllib.error.HTTPError as e:
        if e.code != 302:
            raise
        location = urllib.parse.urlparse(e.headers["Location"])
    params = urllib.parse.parse_qs(location.query or location.fragment)
    data = urllib.parse.urlencode({
        "grant_type": "authorization_code", "client_id": "logchain-frontend", "code": params["code"][0],
        "redirect_uri": REDIRECT, "code_verifier": verifier,
    }).encode()
    return json.load(opener.open(f"{OIDC}/token", data))["access_token"]


def call(token: str, method: str, path: str, body) -> int:
    req = urllib.request.Request(
        API + path, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        return urllib.request.urlopen(req, context=CTX).status
    except urllib.error.HTTPError as e:
        return e.code


def roles_in(token: str) -> set:
    claims = json.loads(base64.urlsafe_b64decode(token.split(".")[1] + "=="))
    return set(claims.get("realm_access", {}).get("roles", [])) & APP_ROLES


def main() -> int:
    print(f"API {API} · Keycloak {KC}")
    tokens = {}
    for role in ROLES:
        password = ENV.get(f"{role.upper()}_USER_PASSWORD", "")
        if not password:
            print(f"✗ ไม่มี {role.upper()}_USER_PASSWORD ใน .env — รัน ./scripts/seed-test-users.sh ก่อน", file=sys.stderr)
            return 1
        tokens[role] = login(f"{role}-user", password)
        got = roles_in(tokens[role])
        print(f"  {role}-user → role ใน token: {sorted(got)}" + ("" if got == {role} else "  ✗ ต้องมี role เดียวคือ " + role))

    bad = 0
    width = max(len(f"{m} {p}") for m, p, _, _ in ALLOWED) + 2
    print("\n" + "endpoint".ljust(width) + "".join(r.rjust(10) for r in ROLES))
    for method, path, body, allowed in ALLOWED:
        row = f"{method} {path}".ljust(width)
        for role in ROLES:
            code = call(tokens[role], method, path, body)
            ok = code != 403 if role in allowed else code == 403
            bad += not ok
            row += (str(code) + ("" if ok else "✗")).rjust(10)
        print(row)

    no_token = {call("invalid-token", m, p, b) for m, p, b, _ in ALLOWED}
    no_token_ok = no_token == {401}
    print(f"\ntoken ปลอม → {sorted(no_token)}" + ("" if no_token_ok else "  ✗ ต้องได้ 401 ทุกตัว"))
    bad += not no_token_ok
    print("✓ ตรงทุกช่อง" if bad == 0 else f"✗ ไม่ตรง {bad} ช่อง")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
