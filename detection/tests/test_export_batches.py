"""
test ของ export_batches — pure (sort/chunk/label) รันบน host ได้
"""
import unittest

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from export_batches import sort_logs, chunk, batch_label  # noqa: E402


def app_log(i, src="app-web-1"):
    return {"id": f"{i:04d}", "source": src, "eventType": "WEB_REQUEST",
            "createdAt": f"2026-09-29T10:00:{i % 60:02d}"}


def atk_log(i, kind="bruteforce"):
    return {"id": f"9{i:03d}", "source": f"atk-{kind}", "eventType": "AUTH_FAILURE",
            "createdAt": f"2026-09-29T11:00:{i % 60:02d}"}


class TestSortChunk(unittest.TestCase):
    def test_sort_by_createdat_then_id(self):
        logs = [
            {"id": "b", "createdAt": "2026-09-29T10:00:00"},
            {"id": "a", "createdAt": "2026-09-29T10:00:00"},
            {"id": "c", "createdAt": "2026-09-29T09:00:00"},
        ]
        out = [l["id"] for l in sort_logs(logs)]
        self.assertEqual(out, ["c", "a", "b"])  # เวลาเก่ากว่ามาก่อน · id เป็น tie-break

    def test_chunk_drops_incomplete_tail(self):
        logs = list(range(250))
        chunks = chunk(logs, 100)
        self.assertEqual(len(chunks), 2)  # 250 → 2 ก้อนเต็ม ทิ้ง 50
        self.assertEqual(len(chunks[0]), 100)

    def test_chunk_exact_multiple(self):
        self.assertEqual(len(chunk(list(range(200)), 100)), 2)

    def test_chunk_fewer_than_size(self):
        self.assertEqual(chunk(list(range(50)), 100), [])


class TestLabel(unittest.TestCase):
    def test_pure_normal_batch(self):
        batch = [app_log(i) for i in range(100)]
        self.assertEqual(batch_label(batch, 0.8), "normal")

    def test_pure_attack_batch(self):
        batch = [atk_log(i, "portscan") for i in range(100)]
        self.assertEqual(batch_label(batch, 0.8), "attack:portscan")

    def test_bruteforce_prefix_split(self):
        batch = [atk_log(i, "bruteforce") for i in range(100)]
        self.assertEqual(batch_label(batch, 0.8), "attack:bruteforce")

    def test_mixed_batch_below_purity_is_dropped(self):
        batch = [app_log(i) for i in range(60)] + [atk_log(i) for i in range(40)]
        self.assertIsNone(batch_label(batch, 0.8))  # 60% < 80% → ทิ้ง

    def test_majority_attack_meets_purity(self):
        batch = [atk_log(i, "dos") for i in range(85)] + [app_log(i) for i in range(15)]
        self.assertEqual(batch_label(batch, 0.8), "attack:dos")

    def test_unknown_source_is_dropped(self):
        batch = [{"source": "weird", "eventType": "X"} for _ in range(100)]
        self.assertIsNone(batch_label(batch, 0.8))


if __name__ == "__main__":
    unittest.main()
