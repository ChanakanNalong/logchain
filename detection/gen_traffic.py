"""
gen_traffic.py — ยิง traffic ปกติ + สถานการณ์โจมตี ผ่าน POST /api/v1/logs จริง (สเตจ 4 ของ Isolation Forest)

**รันบน clone (logchain-smoke) เท่านั้น** — ตาราง logs เป็น append-only ยิงเข้าชุดจริงลบไม่ได้

log ปกติ source ขึ้นต้น "app-" · log โจมตี source ขึ้นต้น "atk-<ชนิด>" เพื่อให้ export_batches.py
label batch ได้จาก source ที่ครองเสียงข้างมาก (โจมตียิงเป็น burst เข้มข้น batch จึงบริสุทธิ์)

ใช้ urllib (stdlib) รันที่ไหนก็ได้ ไม่ต้องมี dependency
แนะนำ --secret (สคริปต์ขอ+refresh token เอง กัน 401 หมดอายุกลางการยิงยาว):
  python gen_traffic.py --base-url https://localhost:3443 \
      --secret "$LOGCHAIN_INGESTOR_SECRET" \
      --normal-batches 150 --attacks bruteforce,portscan,dos --insecure
(หรือ --token "$T" แบบเดิม แต่ไม่ refresh — เสี่ยง 401 ถ้ายิงเกิน ~5 นาที)

createdAt กำหนดโดย server (CreateDateColumn) — เราคุมลำดับด้วยลำดับการยิง (sequential)
"""
from __future__ import annotations

import argparse
import json
import random
import ssl
import sys
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError


def fetch_token(opener, token_url, client_id, secret) -> str:
    """ขอ access token ด้วย client_credentials — ใช้ตอนเริ่มและตอน refresh (401)"""
    data = urllib.parse.urlencode(
        {"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret}
    ).encode()
    req = urllib.request.Request(token_url, data=data, method="POST")
    with opener.open(req, timeout=15) as r:
        tok = json.load(r).get("access_token")
    if not tok:
        raise SystemExit("ขอ token ไม่ได้ — ตรวจ --token-url / --secret / client-id")
    return tok

NORMAL_EVENTS = ["WEB_REQUEST", "FILE_ACCESS", "DB_QUERY", "API_CALL", "CACHE_HIT", "LOGIN_SUCCESS"]
NORMAL_SOURCES = [f"app-web-{i}" for i in range(1, 7)] + [f"app-svc-{i}" for i in range(1, 4)]


def post_log(opener, url, token, log):
    body = json.dumps(log).encode()
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with opener.open(req, timeout=15) as r:
        return r.status


def normal_log(rng: random.Random) -> dict:
    sev = rng.choices(["INFO", "DEBUG", "WARNING"], weights=[80, 15, 5])[0]
    return {
        "source": rng.choice(NORMAL_SOURCES),
        "eventType": rng.choice(NORMAL_EVENTS),
        "severity": sev,
        "sourceIp": f"10.0.{rng.randint(0, 6)}.{rng.randint(1, 200)}",
        "message": f"normal traffic {rng.randint(1000, 9999)}",
        "classification": "INTERNAL",
    }


def attack_logs(kind: str, n: int, rng: random.Random) -> list[dict]:
    """สร้าง log ของการโจมตีหนึ่งชนิด (source=atk-<kind>) จำนวน n รายการ"""
    out = []
    for _ in range(n):
        if kind == "bruteforce":
            # AUTH_FAILURE จำนวนมากจาก IP น้อย → frac_auth_failure สูง
            log = {
                "eventType": "AUTH_FAILURE", "severity": "WARNING",
                "sourceIp": f"203.0.113.{rng.randint(1, 4)}",
                "message": f"failed login attempt {rng.randint(1, 999)}",
            }
        elif kind == "portscan":
            # CONN_ATTEMPT จาก IP ต้นทางหลากหลายมาก → distinct_source_ips สูง
            log = {
                "eventType": "CONN_ATTEMPT", "severity": "WARNING",
                "sourceIp": f"198.51.{rng.randint(0, 255)}.{rng.randint(1, 254)}",
                "message": f"connection to port {rng.randint(1, 65535)}",
            }
        elif kind == "dos":
            # flood event ประเภทเดียวอัตราสูง → max_event_type_share สูง + entropy ต่ำ
            log = {
                "eventType": "HTTP_FLOOD", "severity": "ERROR",
                "sourceIp": f"192.0.2.{rng.randint(1, 20)}",
                "message": "GET / HTTP/1.1",
            }
        else:
            raise SystemExit(f"ไม่รู้จักชนิดโจมตี: {kind}")
        log.update(source=f"atk-{kind}", classification="INTERNAL")
        out.append(log)
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="ยิง traffic ปกติ + โจมตี ผ่าน POST /logs (clone เท่านั้น)")
    ap.add_argument("--base-url", required=True, help="เช่น https://localhost:3443")
    ap.add_argument("--token", help="access token (ใช้ครั้งเดียว ไม่ refresh) — แนะนำใช้ --secret แทน")
    ap.add_argument("--secret", help="client secret ของ log-ingestor → สคริปต์ขอ+refresh token เอง (กัน 401 หมดอายุกลางคัน)")
    ap.add_argument("--token-url", default=None,
                    help="เช่น https://localhost:8443/realms/logchain/protocol/openid-connect/token (default อนุมานจาก base-url เปลี่ยน 3443→8443)")
    ap.add_argument("--client-id", default="log-ingestor")
    ap.add_argument("--normal-batches", type=int, default=150, help="จำนวน batch ปกติ (×100 log)")
    ap.add_argument("--attacks", default="bruteforce,portscan,dos", help="ชนิดโจมตี คั่นด้วย comma")
    ap.add_argument("--attack-batches", type=int, default=8, help="จำนวน batch ต่อชนิดโจมตี")
    ap.add_argument("--batch-size", type=int, default=100)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--insecure", action="store_true", help="ข้ามตรวจ TLS (self-signed ของ clone)")
    args = ap.parse_args(argv)

    if not args.secret and not args.token:
        raise SystemExit("ต้องมี --secret (แนะนำ · refresh เอง) หรือ --token อย่างน้อยหนึ่งอย่าง")

    rng = random.Random(args.seed)
    url = args.base_url.rstrip("/") + "/api/v1/logs"
    # ตั้ง SSL context ที่ opener ผ่าน HTTPSHandler (open() ไม่รับ context)
    if args.insecure:
        ctx = ssl._create_unverified_context()
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
    else:
        opener = urllib.request.build_opener()

    token_url = args.token_url or (args.base_url.rstrip("/").replace(":3443", ":8443")
                                   + "/realms/logchain/protocol/openid-connect/token")
    # โหมด secret = ขอ token เอง + refresh เมื่อ 401 (กัน token หมดอายุกลางการยิงยาว)
    tok = {"v": args.token or fetch_token(opener, token_url, args.client_id, args.secret)}

    def send(log, phase, _retry=True):
        try:
            st = post_log(opener, url, tok["v"], log)
            if st not in (200, 201):
                print(f"  ! {phase}: HTTP {st}")
        except HTTPError as e:
            if e.code == 401 and args.secret and _retry:
                tok["v"] = fetch_token(opener, token_url, args.client_id, args.secret)  # refresh แล้วลองใหม่
                return send(log, phase, _retry=False)
            print(f"  ! {phase}: {e}")
            raise SystemExit(f"หยุด — ยิงไม่สำเร็จ ({e}) · ตรวจ token/secret/base-url")
        except URLError as e:
            print(f"  ! {phase}: {e}")
            raise SystemExit(f"หยุด — ยิงไม่สำเร็จ ({e}) · ตรวจ base-url")

    total = 0
    n_normal = args.normal_batches * args.batch_size
    print(f"▶ ยิง normal {n_normal} log (source app-*)")
    for i in range(n_normal):
        send(normal_log(rng), "normal")
        total += 1
        if (i + 1) % 1000 == 0:
            print(f"  normal {i + 1}/{n_normal}")

    attacks = [a.strip() for a in args.attacks.split(",") if a.strip()]
    for kind in attacks:
        n = args.attack_batches * args.batch_size
        print(f"▶ ยิงโจมตี {kind} {n} log (source atk-{kind})")
        for log in attack_logs(kind, n, rng):
            send(log, kind)
            total += 1

    print(f"✓ ยิงครบ {total} log · ต่อไป: export_batches.py จาก DB ของ clone")
    return 0


if __name__ == "__main__":
    sys.exit(main())
