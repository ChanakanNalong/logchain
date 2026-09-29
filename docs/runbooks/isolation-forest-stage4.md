# Runbook — สเตจ 4 ของ Isolation Forest: train + วัดผลบน clone

> **กลยุทธ์ B (pipeline จริงบน clone)** — ยิง traffic ปกติ + โจมตีผ่าน `POST /logs` จริงบน `logchain-smoke`
> แล้ว export → train → วัดผล · **ห้ามรันบนชุดจริง** (ตาราง `logs` append-only ลบไม่ได้ จะพองสถิติถาวร)
>
> เครื่องมืออยู่ใน `detection/`: `gen_traffic.py` · `export_batches.py` · `train_isoforest.py` · `eval_isoforest.py`
> (ทดสอบ toolchain offline แล้ว: synthetic → P 0.857 · R 1.0 · FP 0.02 — ตัวเลขจริงมาจากขั้นตอนนี้)

## 0. ก่อนเริ่ม
- clone อยู่ `~/clone_logchain/logchain` (project `logchain-smoke`) · ชุดจริงจะถูก **หยุดชั่วคราว**
- `gen_traffic.py` · `export_batches.py` = stdlib รันด้วย `python3` บน host ได้ · `train`/`eval` รันในอิมเมจ (มี scikit-learn)

## 1. สลับมา clone
```bash
cd ~/Documents/logchain && docker compose down                 # หยุดชุดจริง (ไม่มี -v)
cd ~/clone_logchain/logchain
COMPOSE_PROJECT_NAME=logchain-smoke HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d
# รอ backend healthy: docker inspect -f '{{.State.Health.Status}}' logchain-backend
```

## 2. token ของ ingestor (จาก Keycloak ของ clone)
```bash
cd ~/clone_logchain/logchain && set -a; . ./.env; set +a
T=$(curl -sk -X POST "https://localhost:8443/realms/logchain/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=log-ingestor \
  -d "client_secret=$LOGCHAIN_INGESTOR_SECRET" | jq -r .access_token)
echo "${T:0:20}…"   # ต้องไม่ว่าง
```

## 3. ยิง traffic (ปกติ + โจมตี 3 ชนิด) ผ่าน pipeline จริง
```bash
cd ~/clone_logchain/logchain
python3 detection/gen_traffic.py --base-url https://localhost:3443 --token "$T" \
  --normal-batches 150 --attacks bruteforce,portscan,dos --attack-batches 8 --insecure
# ~17,400 log · log ปกติ source app-* · โจมตี source atk-<ชนิด>
```

## 4. export log จาก DB ของ clone → JSONL
```bash
docker exec logchain-postgres psql -U logchain -d logchain -Atc \
 "select row_to_json(t) from (
    select id, source, event_type as \"eventType\", severity,
           host(source_id) as \"sourceIp\", cde_scope as \"cdeScope\", created_at as \"createdAt\"
    from logs order by created_at, id) t" > /tmp/logs.jsonl
wc -l /tmp/logs.jsonl
```

## 5. logs → labeled batches
```bash
python3 detection/export_batches.py --input /tmp/logs.jsonl \
  --train-out /tmp/train_normal.jsonl --eval-out /tmp/eval_labeled.jsonl
# ดูสรุป: normal ≥ 100 · attack ต่อชนิด ~8 · ทิ้ง(ปนกัน) ไม่กี่ใบ
```

## 6. train (ในอิมเมจ detection)
```bash
cd ~/clone_logchain/logchain
docker run --rm -v "$PWD/detection:/w" -v /tmp:/data -w /w --entrypoint python \
  logchain-detection:dev train_isoforest.py --input /data/train_normal.jsonl \
  --output /data/isoforest_model.joblib --contamination 0.02
```

## 7. วัดผล → ตัวเลขลงเล่ม (4.6.6 / DR-09-10)
```bash
docker run --rm -v "$PWD/detection:/w" -v /tmp:/data -w /w --entrypoint python \
  logchain-detection:dev eval_isoforest.py --model /data/isoforest_model.joblib \
  --eval /data/eval_labeled.jsonl --out /data/eval_result.json
# จด: Precision · Recall · F1 · FP-rate · recall แยกชนิดโจมตี → เล่ม
# เก็บ eval_result.json + train/eval jsonl ไว้ที่ ~/Documents/logchain-data/isoforest/ (ไม่อยู่ใน git)
```

## 8. ติดตั้งโมเดลลงชุดจริง
```bash
cp /tmp/isoforest_model.joblib ~/Documents/logchain/detection/data/isoforest_model.joblib
# กลับชุดจริง (ข้อ 9) แล้ว rebuild detection ให้ image มีโมเดล:
#   HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose build detection-api
#   docker compose up -d --no-deps detection-api detection-consumer
# ยืนยัน: docker logs logchain-detection-api | grep "Isolation Forest"  → "loaded"
# commit โมเดล (เหมือน deeplog_model.pt ที่ track อยู่):
#   git add detection/data/isoforest_model.joblib
```

## 9. สลับกลับชุดจริง
```bash
cd ~/clone_logchain/logchain && COMPOSE_PROJECT_NAME=logchain-smoke docker compose down
cd ~/Documents/logchain && HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d
# batch ที่ปิดหลังจากนี้จะมี if_anomaly/if_score · หน้า Verify โชว์ badge Anomaly/Normal
```

## 10. (ไม่บังคับ) ล้าง volume ของ clone เมื่อเลิกใช้
```bash
docker compose -p logchain-smoke down -v   # volume logchain-smoke_* 9 ตัว — ไม่โดน logchain_*
```

---
**ข้อควรระวังในเล่ม (จำเป็น):** ตัวเลขจากขั้นตอนนี้มาจาก**สถานการณ์จำลองที่สร้างเอง** ผ่าน pipeline จริง —
น้ำหนักทางวิชาการน้อยกว่า DeepLog ที่วัดบนชุดข้อมูลมาตรฐาน HDFS · ต้องระบุชัดว่าเป็น controlled evaluation
และ Isolation Forest เป็นตัวเสริม (ระดับที่ 3) ไม่ใช่ตัวจับหลัก
