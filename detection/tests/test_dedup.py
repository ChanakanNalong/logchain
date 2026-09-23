"""
รัน: cd detection && python -m unittest discover -s tests -t . -v
(ต้องมี PyYAML — ใช้ image ของ detection ได้: ดู docs/worklog/2026-09-23.md หัวข้อ 16)
"""
import unittest
from pathlib import Path

from app.dedup import SeenIds
from app.rules import RuleEngine

RULES = Path(__file__).parent.parent / "rules" / "security_rules.yaml"


class SeenIdsTest(unittest.TestCase):
    def test_first_time_is_new_second_is_duplicate(self):
        seen = SeenIds()
        self.assertFalse(seen.is_duplicate("a"))
        self.assertTrue(seen.is_duplicate("a"))
        self.assertFalse(seen.is_duplicate("b"))

    def test_missing_id_is_never_a_duplicate(self):
        seen = SeenIds()
        for _ in range(3):
            self.assertFalse(seen.is_duplicate(None))
            self.assertFalse(seen.is_duplicate(""))
        self.assertEqual(len(seen), 0)

    def test_bounded_and_evicts_oldest(self):
        seen = SeenIds(capacity=2)
        seen.is_duplicate("a")
        seen.is_duplicate("b")
        seen.is_duplicate("c")  # a หลุด
        self.assertEqual(len(seen), 2)
        self.assertFalse(seen.is_duplicate("a"))

    def test_recently_seen_duplicate_is_kept(self):
        seen = SeenIds(capacity=2)
        seen.is_duplicate("a")
        seen.is_duplicate("b")
        seen.is_duplicate("a")  # ซ้ำ → a กลายเป็นตัวล่าสุด
        seen.is_duplicate("c")  # b หลุดแทน a
        self.assertTrue(seen.is_duplicate("a"))
        self.assertFalse(seen.is_duplicate("b"))


class ReplayDoesNotInflateThresholdTest(unittest.TestCase):
    """
    เคสจริงที่ 3.4 กลัว: AUTH_FAILURE 4 ใบ (ต่ำกว่าเกณฑ์ 5710 = 5 ใน 60 วิ) แต่ใบหนึ่งถูก replay ซ้ำ
    """

    def _event(self, i: int) -> dict:
        return {
            "id": f"log-{i}",
            "source": "web-server-01",
            "eventType": "AUTH_FAILURE",
            "message": "authentication failed for user jdoe - invalid credentials",
            "createdAt": f"2026-09-23T10:00:0{i}Z",
        }

    def _run(self, events, seen=None):
        engine = RuleEngine(RULES)
        matches = []
        for ev in events:
            if seen is not None and seen.is_duplicate(ev.get("id")):
                continue
            m = engine.evaluate(ev)
            if m and m["rule_id"] == 5710:
                matches.append(ev["id"])
        return matches

    def test_without_dedup_a_replayed_event_triggers_5710(self):
        events = [self._event(i) for i in range(4)] + [self._event(3)]
        self.assertEqual(self._run(events), ["log-3"])

    def test_with_dedup_it_does_not(self):
        events = [self._event(i) for i in range(4)] + [self._event(3)]
        self.assertEqual(self._run(events, SeenIds()), [])

    def test_five_distinct_events_still_trigger(self):
        events = [self._event(i) for i in range(5)]
        self.assertEqual(self._run(events, SeenIds()), ["log-4"])


if __name__ == "__main__":
    unittest.main()
