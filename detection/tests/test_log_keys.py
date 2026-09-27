"""
รัน: cd detection && python -m unittest discover -s tests -t . -v
"""
import json
import unittest

from app.log_keys import DRAIN_STATE_PATH, UNKNOWN_KEY, LogKeyMatcher, mask


class MaskTest(unittest.TestCase):
    def test_masks_block_ip_port_and_numbers(self):
        self.assertEqual(
            mask("Receiving block blk_-1608999687919862906 src: /10.250.19.102:54106 dest: /10.250.19.102:50010"),
            "Receiving block <BLK> src: <IP> dest: <IP>",
        )
        self.assertEqual(mask("size 67108864"), "size <NUM>")

    def test_backend_pii_masked_forms_mask_the_same(self):
        # backend (pii-masking.service.ts) ส่งมาเป็น .xxx / [PAN] — ต้องได้ token เดียวกับ log ดิบที่ใช้ train
        self.assertEqual(
            mask("Receiving block blk_-1234567890123456 src: /10.250.19.xxx:54106 dest: /10.250.19.xxx:50010"),
            mask("Receiving block blk_-1234567890123456 src: /10.250.19.102:54106 dest: /10.250.19.102:50010"),
        )
        self.assertEqual(mask("Deleting block blk_-[PAN] file x"), "Deleting block <BLK> file x")

    def test_version_string_is_not_an_ip(self):
        # regex เดิม (3 ส่วน) จับ 1.2.3 เป็น IP
        self.assertEqual(mask("version 1.2.3"), "version <NUM>.<NUM>.<NUM>")


class LogKeyMatcherTest(unittest.TestCase):
    def setUp(self):
        self.m = LogKeyMatcher({
            "1": "Deleting block <BLK> file <*>",
            "2": "writeBlock <BLK> received exception <*>",
            "3": "writeBlock <BLK> received exception java.io.IOException",
        })

    def test_wildcard_matches_exactly_one_token(self):
        self.assertEqual(self.m.match("Deleting block <BLK> file /mnt/x"), 1)
        self.assertEqual(self.m.match("Deleting block <BLK> file /mnt/x extra"), UNKNOWN_KEY)

    def test_most_specific_template_wins(self):
        self.assertEqual(self.m.match("writeBlock <BLK> received exception java.io.IOException"), 3)
        self.assertEqual(self.m.match("writeBlock <BLK> received exception java.net.Other"), 2)

    def test_unmatched_message_is_unknown(self):
        self.assertEqual(self.m.match("user admin logged in"), UNKNOWN_KEY)
        self.assertEqual(self.m.match(""), UNKNOWN_KEY)


class TrainedTemplatesTest(unittest.TestCase):
    """template ที่ ship ไปกับ image ต้องเข้ากับโมเดล — key 1..N ต่อเนื่อง และ N + 1 = NUM_CLASSES"""

    def test_keys_are_contiguous_and_fit_model(self):
        with open(DRAIN_STATE_PATH) as f:
            keys = sorted(int(k) for k in json.load(f))
        self.assertEqual(keys, list(range(1, len(keys) + 1)))
        # อ่านค่าจากไฟล์ตรง ๆ — import app.model จะโหลด torch
        import re
        from pathlib import Path
        src = (Path(__file__).parent.parent / "app" / "model.py").read_text()
        num_classes = int(re.search(r"^NUM_CLASSES = (\d+)", src, re.M).group(1))
        self.assertEqual(len(keys) + 1, num_classes)

    def test_real_hdfs_line_maps_to_trained_key(self):
        m = LogKeyMatcher.from_file()
        key = m.match(mask("Receiving block blk_-1608999687919862906 src: /10.250.19.102:54106 dest: /10.250.19.102:50010"))
        self.assertEqual(key, 1)


if __name__ == "__main__":
    unittest.main()
