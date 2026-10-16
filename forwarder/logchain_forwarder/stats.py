"""
--stats: อ่าน log ย้อนหลัง (access log ที่ตั้งไว้ + ไฟล์ที่ Caddy roll ไว้ + journald ของ sshd) แล้วพิมพ์ตัวเลขสรุป
ไม่ส่งอะไร ไม่เขียน state — ใช้ตัวกรองชุดเดียวกับตอนส่งจริง (parse_access / parse_sshd + EXCLUDE_IPS + IP ภายใน)

พิมพ์แค่ตัวเลขรวม + เหตุผลที่ส่ง + path ตัวอย่าง (ไม่มี IP / header) ให้วางในแชทได้
"""
import collections
import glob
import json
import os
import subprocess
from datetime import datetime, timezone

from .parsers import (HEALTH_PATHS, STATIC_ASSET, _internal, _suspicious, parse_access, parse_journal_json,
                      parse_networks, parse_ua_list)


def _access_files(path: str) -> list:
    """access.log + ไฟล์ที่ roll แล้ว (Caddy: access-<เวลา>.log · logrotate: access.log.1)"""
    d, base = os.path.split(path)
    stem, ext = os.path.splitext(base)
    found = set(glob.glob(os.path.join(d or ".", f"{stem}*{ext}"))) | set(glob.glob(path + ".*"))
    found.add(path)
    return sorted(p for p in found if os.path.isfile(p) and not p.endswith(".gz"))


def _hour(ts) -> str:
    try:
        return datetime.fromtimestamp(float(ts), timezone.utc).strftime("%Y-%m-%d %H:00")
    except (TypeError, ValueError):
        return "?"


def access_stats(paths: list, trust_cf: bool, exclude, all_requests: bool = True, exclude_ua=()) -> dict:
    total = sent = static = monitor = 0
    per_hour = collections.Counter()
    sent_hour = collections.Counter()
    severity = collections.Counter()
    ips = set()
    reasons = collections.Counter()
    sample = collections.Counter()
    hosts = collections.Counter()
    files = []
    for path in paths:
        for f in _access_files(path):
            files.append(f)
            with open(f, encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        e = json.loads(line)
                        req = e.get("request") or {}
                    except ValueError:
                        continue
                    if e.get("logger") not in (None, "http.log.access") and not req:
                        continue
                    total += 1
                    hour = _hour(e.get("ts"))
                    per_hour[hour] += 1
                    hosts[req.get("host") or "?"] += 1
                    client = req.get("client_ip") or req.get("remote_ip")
                    if client and not _internal(client, exclude):
                        ips.add(client)
                    p = parse_access(line, trust_cf, exclude, all_requests, exclude_ua)
                    bare = (req.get("uri") or "/").split("?")[0]
                    if not p:
                        if all_requests and client and not _internal(client, exclude) and bare not in HEALTH_PATHS:
                            if STATIC_ASSET.match(bare):
                                static += 1
                            else:
                                monitor += 1  # ที่เหลือที่ไม่ส่ง = UA ของ monitor (HTTP_EXCLUDE_UA)
                        continue
                    sent += 1
                    sent_hour[hour] += 1
                    severity[p["severity"]] += 1
                    if p["severity"] == "WARNING":
                        ua = ((req.get("headers") or {}).get("User-Agent") or [""])[0]
                        reasons[_suspicious(req.get("uri") or "/", ua, int(e.get("status") or 0))] += 1
                    sample[(req.get("method"), bare[:60], e.get("status"))] += 1
    hours = len(per_hour) or 1
    return {
        "files": files,
        "requests": total,
        "hours_covered": len(per_hour),
        "requests_per_hour_avg": round(total / hours, 1),
        "requests_per_hour_peak": max(per_hour.values()) if per_hour else 0,
        "unique_external_ips": len(ips),
        "hosts": dict(hosts.most_common(5)),
        "all_requests": all_requests,
        "dropped_static": static,
        "dropped_monitor_ua": monitor,
        "would_send": sent,
        "would_send_per_hour_avg": round(sent / hours, 1),
        "would_send_per_hour_peak": max(sent_hour.values()) if sent_hour else 0,
        "severity": dict(severity),
        "reasons": dict(reasons.most_common()),
        "top_sent": [f"{m} {u} {s} ×{n}" for (m, u, s), n in sample.most_common(10)],
    }


def sshd_stats(journal_args: str, since_hours: int) -> dict:
    cmd = ["journalctl", *journal_args.split(), "--since", f"-{since_hours}h", "-o", "json", "--no-pager"]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, errors="replace", timeout=120).stdout
    except (OSError, subprocess.TimeoutExpired) as err:
        return {"error": str(err)}
    entries = sent = 0
    kinds = collections.Counter()
    for raw in out.splitlines():
        entries += 1
        p, _ = parse_journal_json(raw)
        if p:
            sent += 1
            kinds[" ".join(p["message"].split()[:2])] += 1
    return {"journal_entries": entries, "would_send": sent, "kinds": dict(kinds.most_common())}


def run(cfg: dict, since_hours: int) -> int:
    from .forwarder import truthy  # noqa: PLC0415 — กัน import วน

    exclude = parse_networks(cfg["EXCLUDE_IPS"])
    paths = [p.strip() for p in cfg["ACCESS_LOGS"].split(",") if p.strip()]
    report = {"exclude_ips": [str(n) for n in exclude]}
    if paths:
        report["access"] = access_stats(paths, truthy(cfg["TRUST_CF_CONNECTING_IP"]), exclude,
                                        truthy(cfg["HTTP_ALL_REQUESTS"]), parse_ua_list(cfg["HTTP_EXCLUDE_UA"]))
    if truthy(cfg["SSH_ENABLED"]) and cfg["SSH_MODE"] == "journal":
        report["sshd"] = sshd_stats(cfg["SSH_JOURNAL_ARGS"], since_hours)
    report["rate_cap_per_hour"] = int(cfg["RATE_PER_HOUR"])
    report["info_cap_per_hour"] = max(int(cfg["RATE_PER_HOUR"]) - int(cfg["RATE_RESERVE_WARNING"]), 0)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0
