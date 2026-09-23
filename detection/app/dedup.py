"""
กัน event ซ้ำก่อนเข้า rule engine / DeepLog

backend replay log ที่ค้าง `kafka_pending_logs` แบบ at-least-once — ถ้าลบออกจากคิวไม่สำเร็จ
หลังส่งแล้ว log ใบนั้นจะถูกส่งซ้ำรอบหน้า · rule แบบ threshold จะนับซ้ำ (4 ครั้งจริงกลายเป็น 5 → 5710 เด้ง)
และ buffer ของ DeepLog ได้ log key ซ้ำ → sequence เพี้ยน

ใช้ `id` ของ log (uuid จาก backend) เป็น key · จำไว้ในหน่วยความจำแบบจำกัดจำนวน (ตัวเก่าสุดหลุดก่อน)
restart แล้วลืม **โดยตั้งใจ** — ต้องลืมพร้อม state อื่น (ประวัติของ RuleEngine, buffer ของ DeepLog)
ถ้าจำ id ไว้ถาวรแต่ประวัติหาย message ที่ Kafka redeliver หลัง crash จะถูกข้าม → threshold นับขาด
→ rule ไม่เด้งทั้งที่โดนโจมตีจริง (ตัดสินใจไว้ใน docs/plan/next-steps.md หมวด "ห้ามทำ")
"""
from collections import OrderedDict
from typing import Optional


class SeenIds:
    def __init__(self, capacity: int = 10_000):
        self._capacity = capacity
        self._ids: "OrderedDict[str, None]" = OrderedDict()

    def is_duplicate(self, log_id: Optional[str]) -> bool:
        """
        True = เคยเห็น id นี้แล้ว (ให้ข้าม) · False = ใหม่ และจำไว้แล้ว
        ไม่มี id → ถือว่าใหม่เสมอ (ไม่มีอะไรให้เทียบ ดีกว่าทิ้ง log)
        """
        if not log_id:
            return False
        if log_id in self._ids:
            self._ids.move_to_end(log_id)
            return True
        self._ids[log_id] = None
        if len(self._ids) > self._capacity:
            self._ids.popitem(last=False)
        return False

    def __len__(self) -> int:
        return len(self._ids)
