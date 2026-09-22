"""
Kafka consumer - รับ log จาก api-gateway -> detect -> push alert
สำหรับ dev: รับ log ทีละตัว > maintain buffer ต่อ source -> detect
ตอน production ควร buffer ต่อ session id (เช่น user_id, request_id) แทน
""" 
import json
import logging
import os
import requests
import re
from collections import defaultdict, deque
from kafka import KafkaConsumer, KafkaProducer
from kafka.errors import KafkaError
from drain3 import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig
from app.enrichment import enrich_ip
from app.rules import RuleEngine
from app.vault import get_vault
from prometheus_client import Counter, Histogram, start_http_server
from dotenv import load_dotenv

load_dotenv()

# ตั้ง logging ก่อนทำอะไรที่ log ได้ — ของเดิมอยู่หลัง get_vault() ทำให้ log.info
# "Vault login OK" ถูกยิงตอนยังไม่มี handler แล้วหายเงียบ (warning ยังโผล่ผ่าน
# lastResort handler) เงียบ = ผ่าน ซึ่งสับสนมากเวลา debug
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("consumer")

# Bootstrap Vault ตอน start - ถ้า vault ไม่พร้อม ให้ refuse to start ตั้งแต่ตอนนี้
# ไม่ต้องรอ enrich ตัวแรกถึงค่อย fail
_vault = get_vault()

MESSAGE_COUNT = Counter(
    "consumer_messages_total",
    "Messages processed by consumer",
    ["status"], # success / failed / rule_match / ml_anomaly / normal
)

ALERT_COUNT = Counter(
    "consumer_alerts_published_total",
    "Alerts published to Kafka",
    ["source_type", "severity", "cde"], # rule_match/ml_anomaly, WARNING/CRITICAL, true/false
)

PROCESS_DURATION = Histogram(
    "consumer_process_seconds",
    "Time to process one message end-to-end",
)

# NOTE: ALERT_COUNT ข้างบนนับ "ตรวจเจอ" (เพิ่มที่ call site) ไม่ใช่ "ส่งขึ้น Kafka สำเร็จ"
# ตัวนี้นับเฉพาะตอน publish ล้มเหลว เพื่อให้ส่วนต่างมองเห็นได้จาก Grafana
ALERT_PUBLISH_FAILED = Counter(
    "consumer_alert_publish_failures_total",
    "Alerts ที่ detect เจอแล้วแต่ publish ขึ้น Kafka ไม่สำเร็จ",
    ["topic"],
)

# Start metrics HTTP server (port 9101 - ตาม prometheus.yml)
start_http_server(9101)
log.info("Metrics server started on :9101")

# ---- config ----
KAFKA_BROKER = os.getenv("KAFKA_BROKERS", "localhost:29092")
DETECT_URL  = os.getenv("DETECT_URL", "http://localhost:8000/api/v1/detect")
# วินาทีที่ยอมรอ broker ack ต่อ alert หนึ่งตัวก่อนถือว่าส่งไม่สำเร็จ
PUBLISH_TIMEOUT = float(os.getenv("KAFKA_PUBLISH_TIMEOUT", "10"))

# ---- Kafka mTLS (client -> SSL listener) ----
# ปิดอยู่ = plaintext เหมือนเดิมเป๊ะ, เปิด = ต่อ SSL listener (พอร์ต 39092-39094)
KAFKA_SSL_ENABLED = os.getenv("KAFKA_SSL_ENABLED", "false").lower() in ("true", "1")

def kafka_security_args() -> dict:
    """kwargs ที่ต้องยัดเพิ่มให้ KafkaProducer/KafkaConsumer ตอนเปิด mTLS"""
    if not KAFKA_SSL_ENABLED:
        return {}
    ca, cert, key = (
        os.getenv("KAFKA_SSL_CA"),
        os.getenv("KAFKA_SSL_CERT"),
        os.getenv("KAFKA_SSL_KEY"),
    )
    # เปิด SSL แล้วแต่ path ไม่ครบ = misconfig - ตายตั้งแต่ start ดีกว่า
    # fallback เป็น plaintext เงียบ ๆ แล้วนึกว่า log วิ่งผ่าน mTLS อยู่
    if not (ca and cert and key):
        raise RuntimeError(
            "KAFKA_SSL_ENABLED=true but KAFKA_SSL_CA / KAFKA_SSL_CERT / KAFKA_SSL_KEY is missing"
        )
    return {
        "security_protocol": "SSL",
        "ssl_cafile": ca,
        "ssl_certfile": cert,
        "ssl_keyfile": key,
    }
WINDOW_SIZE = 11 # ต้อง >= window_size + 1 ที่ FastAPI ใช้
BUFFER_SIZE = 30 # เก็บ log key ล่าสุดกี่ตัวต่อ source

rule_engine = RuleEngine()

# ---- Drain (parse log message -> log key) ----
# masking เหมือน parse_logs.py
MASK_PATTERNS = [
    (re.compile(r"blk_-?\d+"), "<BLK>"),
    (re.compile(r"/?\d+\.\d+\.\d+(:\d+)?"), "<IP>"),
    (re.compile(r"\b\d+\b"), "<NUM>"),
]
def mask(text: str) -> str:
    for pattern, repl in MASK_PATTERNS:
        text = pattern.sub(repl, text)
    return text

config = TemplateMinerConfig()
config.profiling_enabled = False
config.drain_sim_th = 0.4
miner = TemplateMiner(config=config)

# ---- buffer per source - เก็บ log key sequence ล่าสุด ----
buffers: dict[str, deque] = defaultdict(lambda: deque(maxlen=BUFFER_SIZE))

# ---- Kafka producer สำหรับ alert ----
producer = KafkaProducer(
    bootstrap_servers=KAFKA_BROKER.split(","),
    value_serializer=lambda v: json.dumps(v).encode(),
    key_serializer=lambda k: k.encode() if k else None,
    **kafka_security_args(),
)

def push_alert(log_event: dict, detection_source: str, detection: dict, ip_intel: dict) -> bool:
    # source_ip = log_event.get("sourceIp")
    # ip_intel = enrich_ip(source_ip)
    """
    ส่ง alert  ไป kafka พร้อม CDE routing

    detection_source: 'RULE' หรือ 'ML' - บอกว่า rule หรือ ML จับได้
    detecttin: dict ที่มี rule_id/severity (rule) หรือ confidence (ml)

    return: True ถ้า broker ack แล้วจริง / False ถ้า publish ไม่สำเร็จ (log ระดับ ERROR ไปแล้ว)
    """
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
    }
    cde_tag = "🔒 CDE " if is_cde_alert else ""
    reason = detection.get("reason") or detection.get("description")
    what = f"{cde_tag}[{detection_source}]: {log_event.get('source')} - {reason}"

    # "ตรวจเจอ" กับ "ส่งถึง Kafka สำเร็จ" เป็นคนละเหตุการณ์ ต้องแยก log ให้ชัด
    # ของเดิมเรียก producer.send() แบบ fire-and-forget แล้ว log 🚨 ALERT ต่อทันที
    # ทำให้ log ขึ้นครบทั้งที่ publish ล้มเหลว (เจอจริงตอน alerts.raw หายหลัง
    # docker compose down -v — alert ไม่เคยเข้า DB โดยไม่มี error ที่ฝั่งไหนเลย)
    log.warning(f"🚨 DETECTED {what}")

    try:
        # .get() บล็อกจนกว่า broker จะ ack จริง — ยอมช้าดีกว่าเงียบแล้วหาย
        meta = producer.send(
            target_topic, key=log_event.get("source"), value=alert
        ).get(timeout=PUBLISH_TIMEOUT)
    # จับ Exception กว้าง ๆ ตั้งใจ: KafkaError (timeout/ไม่มี topic/ไม่มี broker) รวมอยู่แล้ว
    # ส่วนที่เหลือ (serialize พัง, producer ถูกปิด) ก็ห้ามหลุดไปเงียบ ๆ เหมือนกัน
    except Exception as e:
        ALERT_PUBLISH_FAILED.labels(topic=target_topic).inc()
        kind = "KafkaError" if isinstance(e, KafkaError) else type(e).__name__
        log.error(
            f"❌ PUBLISH FAILED → {target_topic} ({kind}: {e}) "
            f"— alert นี้ไม่ถึง backend และจะไม่เข้า DB: {what}"
        )
        return False

    log.info(
        f"✅ PUBLISHED → {meta.topic}[{meta.partition}]@{meta.offset} {what}"
    )
    return True

def _compute_severity(detection: dict, ip_intel: dict) -> str:
    """
    Severity ที่ฉลาดขึ้น - ดู abuse confidence ของ IP ด้วย
    > 75% = CRITICAL, > 25% = WARNING, ปกติ = INFO
    """
    reputation = ip_intel.get("reputation", {})
    if reputation.get("available"):
        confidence = reputation.get("abuse_confidence", 0)
        if confidence >= 75 or reputation.get("is_tor"):
            return "CRITICAL"
        if confidence >= 25:
            return "WARNING"
    return "INFO"

# ---- consumer loop ----
consumer = KafkaConsumer(
    "logs.raw",
    bootstrap_servers=KAFKA_BROKER.split(","),
    group_id="detection-service",
    auto_offset_reset="earliest",
    value_deserializer=lambda v: json.loads(v.decode()),
    **kafka_security_args(),
)

log.info(f"Listening on logs.raw at {KAFKA_BROKER}")

for msg in consumer:
    with PROCESS_DURATION.time():
        try:
            event = msg.value
            message = event.get("message", "")
            source = event.get("source", "unknown")
            source_ip = event.get("sourceIp")

            # ---- STEP 1: Rule-based check (Wazuh-style) ----
            # รันก่อนเพราะ rule แม่นกว่าและเร็วกว่า ML
            rule_match = rule_engine.evaluate(event)
            if rule_match:
                ip_intel = enrich_ip(source_ip)
                push_alert(event, "RULE_MATCH", rule_match, ip_intel)
                MESSAGE_COUNT.labels(status="rule_match").inc()
                ALERT_COUNT.labels(
                    source_type="rule_match",
                    severity=rule_match.get("severity", "WARNING"),
                    cde=str(rule_match.get("cde_alert", False)).lower(),
                ).inc()
                continue

            # ── STEP 2: ML-based detection (DeepLog) ───────
            # ถ้า rule ไม่ match ก็ให้ ML ตรวจ unknown pattern
        
            # 1. parse -> log key
            result = miner.add_log_message(mask(message))
            log_key = result["cluster_id"]

            # 2. add to source buffer
            buffers[source].append(log_key)
            seq = list(buffers[source])

            # 3. ทำ detect เมื่อ buffer ยาวพอ
            if len(seq) < WINDOW_SIZE:
                continue # ยังไม่พอต้องรอ log เพิ่ม

            # 4. call FastAPI
            response = requests.post(DETECT_URL, json={"sequence": seq}, timeout=5)
            response.raise_for_status()
            detection = response.json()

            # 5. ถ้า anomaly -> push alert
            if detection["is_anomaly"]:
                ip_intel = enrich_ip(source_ip)
                ml_result = {
                    "severity":         _compute_severity(detection, ip_intel),
                    "reason":           detection["reason"],
                    "confidence":       detection["confidence"],
                    "sequence_length":  detection["sequence_length"],
                    "cde_alert":        event.get("cdeScope", False),
                }
                push_alert(event, "ML_ANOMALY", ml_result, ip_intel)
                MESSAGE_COUNT.labels(status="ml_anomaly").inc()
                ALERT_COUNT.labels(
                    source_type="ml_anomaly",
                    severity=ml_result["severity"],
                    cde=str(ml_result["cde_alert"]).lower(),
                ).inc()
            else:
                MESSAGE_COUNT.labels(status="normal").inc()

        except Exception as e:
            log.error(f"failed to process message: {e}")
            # production: ส่งไป logs.raw.dlp