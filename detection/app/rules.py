"""
Wazuh-style rule engine
รัน rule check ก่อน Deeplog - จับ known attack pattern (rule)
ส่วน ML จับ unknown pattern
"""
import logging
import re
import time
from datetime import datetime, timezone
from urllib.parse import unquote_plus
import yaml
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

log = logging.getLogger("rule")

RULES_FILE = Path(__file__).parent.parent / "rules" / "security_rules.yaml"

# ล้าง state ของ key ที่เงียบไปนานกว่า window ที่ยาวที่สุด ทุก ๆ กี่ event
# key เป็นราย IP แล้ว — scanner หลายพัน IP จะทำให้ dict โตไม่หยุดถ้าไม่ล้าง
PRUNE_EVERY = 1000

class RuleEngine:
    """
    Rule-based detection engine - แบบ Wazuh

    มีสองโหลด:
        - direct match: regex match กับ message
        - frequency: X events ใน Y วินาที (threshold rule)
    """

    def __init__(self, rule_path: Path = RULES_FILE):
        with open(rule_path) as f:
            self.rules = yaml.safe_load(f).get("rules", [])
        log.info(f"Loaded {len(self.rules)} security rules")

        # compile regex ครั้งเดียวเพื่อ performance
        for r in self.rules:
            r["_compiled"] = [re.compile(p) for p in r.get("match_patterns", [])]
            distinct = r.get("threshold", {}).get("distinct_by")
            r["_distinct"] = re.compile(distinct) if distinct else None

        # state สำหรับ frequency rule: { (rule_id, actor): deque of (ts, log_id, attempt) }
        # attempt = ค่าจาก distinct_by (เช่น port ของ sshd) · None = นับทุกบรรทัด
        self._event_history: dict = defaultdict(lambda: deque(maxlen=100))

        # state สำหรับ requires_prior_rule: { (rule_id, actor): (last_match_ts, log_ids ของ match นั้น) }
        self._prior_matches: dict = {}

        # window ที่ยาวที่สุด — state ที่เก่ากว่านี้ไม่มีผลกับ rule ไหนแล้ว ล้างทิ้งได้
        self._max_window = max(
            [r["threshold"]["window_seconds"] for r in self.rules if "threshold" in r]
            + [r.get("window_seconds", 300) for r in self.rules if "requires_prior_rule" in r]
            + [0]
        )
        self._evaluated = 0

    def evaluate(self, log_event: dict) -> Optional[dict]:
        """
        ทดสอบ log กับ rule ทั้งหมด
        คืน first match (rule + details) หรือ None ถ้าไม่ match
        """
        message     = log_event.get("message", "")
        event_type  = log_event.get("eventType", "")
        cde_scope   = log_event.get("cdeScope", False)
        source      = log_event.get("source", "unknown")
        source_ip   = log_event.get("sourceIp") or None
        log_id      = log_event.get("id")
        # นับ threshold / chain แยกตามผู้กระทำ: IP ถ้ามี ไม่งั้นถอยไปใช้ source (พฤติกรรมเดิม)
        # ใส่ชนิดไว้ใน key กัน source ที่บังเอิญชื่อเหมือน IP ชนกับ IP จริง
        actor       = ("ip", source_ip) if source_ip else ("source", source)
        decoded     = None  # URL-decode เฉพาะเมื่อมี rule ขอ และทำครั้งเดียวต่อ event
        # ใช้เวลาของ event ไม่ใช่เวลาที่รับเข้ามา — backend replay log ที่ค้างคิวตอน Kafka ล่ม
        # ทีเดียวทั้งก้อน ถ้านับหน้าต่างเวลาจากตอนรับ log ที่ห่างกันเป็นชั่วโมงจะกลายเป็น
        # "5 ครั้งใน 60 วินาที" ทันที (rule 5710 เด้งทั้งที่ไม่มีอะไรเกิดขึ้นตอนนี้)
        now         = _event_time(log_event)

        self._evaluated += 1
        if self._evaluated % PRUNE_EVERY == 0:
            self._prune(now)

        for rule in self.rules:
            # filter: event_type
            if "event_types" in rule and event_type not in rule["event_types"]:
                continue

            # filter: cde _scope_only
            # true -> match แค่ log ที่ cdeScope=true
            # false -> match แค่ log ที่ cdeScope=false (rule 90001)
            if "cde_scope_only" in rule and cde_scope != rule["cde_scope_only"]:
                continue

            # check regex match
            matched = False
            # ถ้า rule ไม่มี pattern → match by filter alone (event_types/cde_scope_only ผ่านแล้ว = match)
            if rule["_compiled"]:
                matched = any(pattern.search(message) for pattern in rule["_compiled"])
                if not matched and rule.get("url_decode"):
                    # ลองกับสำเนาที่ decode แล้ว (%20 → ช่องว่าง, + → ช่องว่าง) · message ไม่ถูกแก้
                    if decoded is None:
                        decoded = unquote_plus(message)
                    if decoded != message:
                        matched = any(p.search(decoded) for p in rule["_compiled"])
                if not matched:
                    continue
            # else: ไม่มี pattern → ถือว่า match by filter

            # threshold (frequency rule): ต้องเกิด >= count ครั้งใน window วินาที
            related_log_ids = [log_id] if log_id else []
            if "threshold" in rule:
                key = (rule["id"], actor)
                history = self._event_history[key]
                attempt = None
                if rule["_distinct"]:
                    found = rule["_distinct"].search(message)
                    attempt = found.group(1) if found else None
                history.append((now, log_id, attempt))
                window = rule["threshold"]["window_seconds"]
                count = rule["threshold"]["count"]
                # นับ event ในช่วง window — log_id ของชุดนี้คือหลักฐานของ alert (รวมบรรทัดที่นับซ้ำไม่ได้)
                in_window = [(ts, lid, att) for ts, lid, att in history if now - ts <= window]
                keyed_ts = [ts for ts, _, att in in_window if att is not None]
                pair = rule["threshold"].get("undistinct_pair_seconds")
                attempts = len({att for _, _, att in in_window if att is not None}) + sum(
                    1
                    for ts, _, att in in_window
                    if att is None
                    # บรรทัดไม่มี key ที่มีคู่ที่มี key ใกล้ ๆ = การเดาครั้งเดียวกัน (นับไปแล้ว)
                    and not (pair and any(abs(ts - k) <= pair for k in keyed_ts))
                )
                if attempts < count:
                    continue
                related_log_ids = [lid for _, lid, _ in in_window if lid]

            # requires_prior_rule (chained rule): match เฉพาะเมื่อ rule ก่อนหน้า
            # เคยจับ source เดียวกันได้ภายใน window_seconds
            prior_log_ids = None
            if "requires_prior_rule" in rule:
                prior_id = rule["requires_prior_rule"]
                window = rule.get("window_seconds", 300)
                last_ts, prior_ids = self._prior_matches.get((prior_id, actor), (0.0, []))
                if now - last_ts > window:
                    continue
                prior_log_ids = list(prior_ids)

            # match - บันทึก state สำหรับ chained rule (พร้อม log ที่เป็นหลักฐาน)
            self._prior_matches[(rule["id"], actor)] = (now, related_log_ids)

            match = {
                "rule_id":          rule["id"],
                "description":      rule["description"],
                "severity":         rule["severity"],
                "cde_alert":        rule.get("cde_alert", False),
                "matched_message":  message[:2000], # truncate ถ้ายาว 
                "source_ip":        source_ip,
                "related_log_ids":  related_log_ids,
            }
            if prior_log_ids is not None:
                match["prior_log_ids"] = prior_log_ids
            return match
        
        return None

    def _prune(self, now: float) -> None:
        """ทิ้ง state ของ actor ที่ไม่มี event ใน window ที่ยาวที่สุดแล้ว (ไม่มีผลกับผลตรวจ)"""
        cutoff = now - self._max_window
        for key in [k for k, h in self._event_history.items() if not h or h[-1][0] < cutoff]:
            del self._event_history[key]
        for key in [k for k, (ts, _) in self._prior_matches.items() if ts < cutoff]:
            del self._prior_matches[key]


def _event_time(log_event: dict) -> float:
    """
    เวลาของ event เป็น epoch seconds — อ่านจาก createdAt ที่ backend ใส่มา (ISO-8601 UTC)
    ไม่มี/พังก็ถอยไปใช้เวลาปัจจุบัน ดีกว่าโยน error ทิ้ง log ทั้งใบ
    """
    raw = log_event.get("createdAt")
    if isinstance(raw, str) and raw:
        try:
            return datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
        except ValueError:
            log.warning(f"createdAt อ่านไม่ออก ใช้เวลาปัจจุบันแทน: {raw!r}")
    return time.time()
