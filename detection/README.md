# detection — anomaly detection service

DeepLog (LSTM) + rule engine สำหรับหา log ที่ผิดปกติ แล้ว push alert กลับขึ้น Kafka
ให้ backend (`src/kafka/kafka-consumer.service.ts`) เอาไปแสดงที่หน้า Alerts

> ย้ายมาจาก repo `logchain-detection` (copy ไฟล์ ไม่ได้ merge history — `.git`
> ของ repo เดิมหนัก 4.2 GB เพราะเผลอ commit `venv/` กับ `data/` ไว้)

## 2 process จาก image เดียว

| service | คำสั่ง | หน้าที่ | port |
|---|---|---|---|
| `detection-api` | `uvicorn app.main:app` | โหลด DeepLog แล้วตอบ `POST /api/v1/detect` | 8000 |
| `detection-consumer` | `python -m app.consumer` | อ่าน `logs.raw` → parse → detect → push `alerts.raw` / `alerts.cde` | metrics 9101 |

```
logs.raw ──▶ consumer ──▶ Drain3 parse ──▶ buffer ต่อ source (11 ตัว)
                │
                ├──▶ rule engine (rules/security_rules.yaml)   ──┐
                └──▶ POST detection-api /api/v1/detect          ──┴──▶ alerts.raw
                                                                       alerts.cde
```

## รัน

### โหมด docker compose (ปกติ)

ยกมาพร้อมทั้งระบบจาก repo root — ไม่ต้องทำอะไรเพิ่ม

```bash
cd .. && ./scripts/bootstrap.sh
```

env ทั้งหมดถูกส่งจากบล็อก `environment:` ใน `docker-compose.yml` — **ไม่ได้ใช้
`detection/.env`**

### โหมดรันเองบน host

```bash
python3.12 -m venv venv && source venv/bin/activate
# torch CPU wheel — ไม่ต้องใช้ GPU และเล็กกว่า CUDA build ~3 GB
pip install --index-url https://download.pytorch.org/whl/cpu torch==2.12.0
pip install -r requirements.txt

cp .env.example .env     # แล้วเติม VAULT_DETECTION_ROLE_ID / SECRET_ID
                         # (../scripts/bootstrap.sh เติมให้อัตโนมัติอยู่แล้ว)

uvicorn app.main:app --port 8000      # terminal 1
python -m app.consumer                # terminal 2
```

`app/vault.py` ตั้งใจให้ **refuse to start** ถ้า `VAULT_ADDR` /
`VAULT_DETECTION_ROLE_ID` / `VAULT_DETECTION_SECRET_ID` ไม่ครบ — ดังกว่าปล่อยให้
รันไปเงียบ ๆ แล้วไม่มี alert ออก

> **กับดักตอนอ่าน log:** `consumer.py` เรียก `get_vault()` (บรรทัด 26) **ก่อน**
> `logging.basicConfig()` (บรรทัด 90) — ตอน Vault login สำเร็จมันยิง `log.info`
> ออกไปตอนที่ยังไม่มี handler บรรทัด `Vault login OK` จึง**ไม่โผล่เลย**
> (ส่วนที่พลาดเป็น `log.warning` ซึ่ง lastResort handler ของ Python ปล่อยผ่านให้)
>
> **สรุป: เงียบ = ผ่าน** สัญญาณว่า Vault ผ่านจริงคือ 2 บรรทัดถัดมาที่รันหลัง basicConfig
> ```
> Metrics server started on :9101
> Loaded 9 security rules
> ```
> ถ้าเห็นสองบรรทัดนี้แปลว่า bootstrap Vault ผ่านมาแล้วแน่นอน

## ไฟล์ใน data/

| ไฟล์ | ขนาด | อยู่ใน repo? | ต้องใช้ตอน |
|---|---|---|---|
| `deeplog_model.pt` | 217 KB | ✅ commit | **runtime** — ขาดไม่ได้ |
| `drain_state.json` | 4 KB | ✅ commit | train ใหม่ (47 template ที่เรียนไว้แล้ว) |
| `HDFS.log` | 1.5 GB | ❌ โหลดเอง | train ใหม่ |
| `anomaly_label.csv` | 18 MB | ❌ โหลดเอง | train ใหม่ |
| `hdfs_sequences.csv` | 48 MB | ❌ สร้างเอง | train ใหม่ |
| `train.txt` / `test_*.txt` | 30 MB | ❌ สร้างเอง | train ใหม่ |
| `GeoLite2-City.mmdb` | 66 MB | ❌ โหลดเอง | geo enrichment (optional) |

> **รัน demo ไม่ต้องใช้ dataset เลย** — มีแค่ 2 ไฟล์ที่ commit ไว้ (รวม 221 KB) ก็พอ
> dataset ต้องใช้เฉพาะตอนจะ train โมเดลใหม่

### GeoLite2 (optional)

`app/enrichment.py` เช็ค `GEOLITE_PATH.exists()` — ไม่เจอก็แค่ log
`"GeoLite2 not found - geo enrichment disabled"` แล้วไปต่อ **alert ยังออกปกติ
แค่ไม่มีข้อมูลประเทศ/เมือง**

อยากเปิด: สมัครบัญชีฟรีที่ https://www.maxmind.com/en/geolite2/signup แล้วโหลด
`GeoLite2-City.mmdb` มาวางที่ `data/` — **ห้าม commit** (อยู่ใน `.gitignore` แล้ว)
เพราะ GeoLite2 EULA ห้ามแจกจ่ายซ้ำ

โหมด docker: mount เข้ามาแทน
```yaml
# docker-compose.yml -> detection-consumer
volumes:
  - ./detection/data/GeoLite2-City.mmdb:/app/data/GeoLite2-City.mmdb:ro
```

## train ใหม่

ต้องโหลด HDFS dataset จาก [logpai/loghub](https://github.com/logpai/loghub) ก่อน
(`HDFS_1.tar.gz` — ข้างในมี `HDFS.log` + `anomaly_label.csv`) แล้วแตกลง `data/`

```bash
# 1. HDFS.log -> log key sequences ต่อ block_id  (ได้ hdfs_sequences.csv + drain_state.json)
python parse_logs.py

# 2. split เป็น train (normal อย่างเดียว) / test  (ได้ train.txt, test_normal.txt, test_abnormal.txt)
python prepare_data.py

# 3. train LSTM  (ได้ data/deeplog_model.pt)
python deeplog.py

# 4. วัดผลบน test set — ลองหลายค่า g (top-k threshold) แล้วเลือกที่ F1 ดีสุด
python detect.py
```

ทุกขั้น seed คงที่ (42) ผลจึง reproducible
โมเดลปัจจุบัน: 47 log key, window=10, top-k g=8, **F1 ≈ 0.71** บน HDFS

`deeplog.py` / `detect.py` ใช้ CUDA ถ้ามี (`torch.cuda.is_available()`) —
CPU ก็ train ได้แต่ช้ากว่ามาก ส่วน **inference ตอน runtime ใช้ CPU ล้วน** ซึ่งเป็น
เหตุผลที่ `Dockerfile` ลง torch จาก CPU index

## ตัวแปรสภาพแวดล้อม

| ตัวแปร | default | หมายเหตุ |
|---|---|---|
| `KAFKA_BROKERS` | `localhost:29092` | compose override เป็น `kafka-1:9092,...` |
| `KAFKA_SSL_ENABLED` | `false` | `true` ต้องมี `KAFKA_SSL_CA/CERT/KEY` ครบ ไม่งั้น raise ตอน start |
| `KAFKA_SSL_CA` / `_CERT` / `_KEY` | — | จาก `../infra/kafka/gen-certs.sh` (client ชื่อ `detection`) |
| `KAFKA_PUBLISH_TIMEOUT` | `10` | วินาทีที่รอ broker ack ต่อ alert หนึ่งตัว |
| `DETECT_URL` | `http://localhost:8000/api/v1/detect` | compose override เป็น `http://detection-api:8000/...` |
| `VAULT_ADDR` | — | **บังคับ** |
| `VAULT_DETECTION_ROLE_ID` | — | **บังคับ** — AppRole `detection-service` |
| `VAULT_DETECTION_SECRET_ID` | — | **บังคับ** |

## โครงไฟล์

```
app/
 ├─ main.py        FastAPI: /health, /metrics, POST /api/v1/detect
 ├─ model.py       DeepLog LSTM + singleton detector (โหลด data/deeplog_model.pt)
 ├─ consumer.py    Kafka consumer/producer + Drain3 parsing + buffer ต่อ source
 ├─ rules.py       rule engine (อ่าน rules/security_rules.yaml)
 ├─ enrichment.py  GeoIP + AbuseIPDB lookup (ทั้งคู่ optional)
 ├─ vault.py       AppRole login -> secret/logchain/detection
 └─ schemas.py     pydantic request/response
rules/security_rules.yaml
data/              deeplog_model.pt + drain_state.json (ที่เหลือ gitignored)
parse_logs.py prepare_data.py deeplog.py detect.py   <- training pipeline
```

ดู [FIXES-2026-07-15.md](FIXES-2026-07-15.md) สำหรับประวัติการแก้ที่ค้างไว้
