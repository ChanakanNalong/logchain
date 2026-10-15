"""
รูปแบบ alert ที่ consumer ส่งเข้า Kafka (alerts.raw / alerts.cde) — แยกจาก consumer.py
เพื่อให้เทสได้โดยไม่ต้องต่อ Kafka (consumer.py ต่อ broker ตั้งแต่ตอน import)

ฟิลด์เดิมทั้งหมดต้องคงไว้ตามเดิม — backend (src/kafka/kafka-consumer.service.ts) map
log_id / alert_type / severity / source / title / detail ลง DB
ฟิลด์ใหม่ระดับบนสุด (backend ตัวปัจจุบันยังไม่เก็บ):
    related_log_ids  log ที่เป็นหลักฐานของ alert นี้ (threshold = log ทั้งหน้าต่าง)
    prior_log_ids    rule แบบ chain (5715) = log ของ 5710 ที่เป็นเงื่อนไขก่อนหน้า
"""


def build_alert(log_event: dict, detection_source: str, detection: dict, ip_intel: dict):
    """คืน (topic, alert) — topic ตาม CDE routing"""
    is_cde_alert = detection.get("cde_alert", False) or log_event.get("cdeScope", False)

    # CDE routing: เลือก topic ตาม CDE scope
    target_topic = "alerts.cde" if is_cde_alert else "alerts.raw"

    alert = {
        "log_id":       log_event.get("id"),
        "source":       log_event.get("source"),
        "source_ip":    log_event.get("sourceIp"),
        "alert_type":   detection_source, # "RULE_MATCH" หรือ "ML_ANOMALY"
        "severity":     detection.get("severity", "WARNING"),
        "cde_scope":    log_event.get("cdeScope", False),
        "title":        detection.get("description") or f"DeepLog detect anomaly from {log_event.get('source')}",
        "detail": {
            "rule_id":          detection.get("rule_id"),
            "reason":           detection.get("reason") or detection.get("description"),
            "confidence":       detection.get("confidence"),
            "sequence_length":  detection.get("sequence_length"),
            "log_message":      log_event.get("message"),
            "event_type":       log_event.get("eventType"),
            "ip_intel":         ip_intel,
        },
        "related_log_ids": detection.get("related_log_ids")
                           or ([log_event["id"]] if log_event.get("id") else []),
        "prior_log_ids":   detection.get("prior_log_ids") or [],
    }
    return target_topic, alert
