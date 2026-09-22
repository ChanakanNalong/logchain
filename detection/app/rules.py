"""
Wazuh-style rule engine
รัน rule check ก่อน Deeplog - จับ known attack pattern (rule)
ส่วน ML จับ unknown pattern
"""
import logging
import re
import time
import yaml
from collections import defaultdict, deque
from pathlib import Path
from typing import Optional

log = logging.getLogger("rule")

RULES_FILE = Path(__file__).parent.parent / "rules" / "security_rules.yaml"

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

        # state สำหรับ frequency rule: { (rule_id, source): deque of timestamps }
        self._event_history: dict = defaultdict(lambda: deque(maxlen=100))

        # state สำหรับ requires_prior_rule: { (rule_id, source): last_match_ts }
        self._prior_matches: dict = defaultdict(float)

    def evaluate(self, log_event: dict) -> Optional[dict]:
        """
        ทดสอบ log กับ rule ทั้งหมด
        คืน first match (rule + details) หรือ None ถ้าไม่ match
        """
        message     = log_event.get("message", "")
        event_type  = log_event.get("eventType", "")
        cde_scope   = log_event.get("cdeScope", False)
        source      = log_event.get("source", "unknown")
        now         = time.time()

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
                if not matched:
                    continue
            # else: ไม่มี pattern → ถือว่า match by filter

            # threshold (frequency rule): ต้องเกิด >= count ครั้งใน window วินาที
            if "threshold" in rule:
                key = (rule["id"], source)
                history = self._event_history[key]
                history.append(now)
                window = rule["threshold"]["window_seconds"]
                count = rule["threshold"]["count"]
                # นับ event ในช่วง window
                recent = sum(1 for ts in history if now - ts <= window)
                if recent < count:
                    continue

            # requires_prior_rule (chained rule): match เฉพาะเมื่อ rule ก่อนหน้า
            # เคยจับ source เดียวกันได้ภายใน window_seconds
            if "requires_prior_rule" in rule:
                prior_id = rule["requires_prior_rule"]
                window = rule.get("window_seconds", 300)
                last_ts = self._prior_matches.get((prior_id, source), 0.0)
                if now - last_ts > window:
                    continue

            # match - บันทึก state สำหรับ chained rule
            self._prior_matches[(rule["id"], source)] = now

            return {
                "rule_id":          rule["id"],
                "description":      rule["description"],
                "severity":         rule["severity"],
                "cde_alert":        rule.get("cde_alert", False),
                "matched_message":  message[:2000], # truncate ถ้ายาว 
            }
        
        return None