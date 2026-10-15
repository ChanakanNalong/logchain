# Deploy รอบแก้ตามกรรมการ (migration 4 ตัว + seal/gas/diff/tree) — runbook

ใช้จริงครั้งแรก: **ซ้อมบน stack หลักในเครื่อง 2026-10-15 23:47–23:50** (ไม่มี tx ขึ้น Amoy · nonce wallet 58 ก่อน = หลัง)
ใช้ซ้ำบน cloud ได้ทั้งชุด — เปลี่ยนแค่ path / ชื่อ container ถ้าต่างจากนี้

สิ่งที่ deploy นี้เพิ่ม: migration `AlertLogs` `BatchLogSnapshot` `BatchGasAndIndexes` (ต่อจาก 7 ตัวเดิม) · seal ตาม `SEAL_CRON` + drain
+ guard ยอดเงิน + backoff · `GET /logs` แบบแบ่งหน้า · `/logs/:id/detail` · `/alerts/:id` · `/batches` แบบแบ่งหน้า · `/batches/:id/diff`
· `/batches/:id/tree` · rule ใหม่ของ detection (sshd / per-IP)

> ⚠️ `GET /logs` และ `GET /batches` ไม่ใช่ array แล้ว — dashboard ต้องเป็นรุ่นที่อ่าน `.items` (main ตั้งแต่ `46c7183`)

## 0. ก่อนเริ่ม

```bash
cd ~/Documents/logchain && git pull          # main
docker exec logchain-vault vault status | grep Sealed          # ต้อง false (true → ข้อ 0b)
```

0b. Vault sealed (เช่นหลัง dockerd restart): `HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --no-deps vault-unseal`
— sidecar นี้ init เฉพาะตอน Vault ตอบ uninitialized เท่านั้น ไม่ re-init ของเดิม

## 1. สำรอง

```bash
D=$(date +%F-%H%M)
(umask 077; docker exec logchain-postgres pg_dump -U logchain -d logchain --no-owner > ~/logchain-backup-$D.sql)
(umask 077; docker exec logchain-postgres pg_dump -U logchain -d keycloak --no-owner > ~/logchain-keycloak-backup-$D.sql)
cp .env ~/logchain-env-backup-$D.env && chmod 600 ~/logchain-env-backup-$D.env
```

## 2. ตั้ง `.env`

ค่าที่ใช้ตอนซ้อม (เพิ่ม/แทนที่ ไม่แตะ key อื่น):

| key | ค่า | ทำไม |
|---|---|---|
| `INTEGRITY_AUTO_REANCHOR` | `false` | ไม่ส่ง root จาก DB ขึ้น chain เองตอน batch UNVERIFIED (ดู README Troubleshooting) |
| `SEAL_CRON` | `"0 */30 * * * *"` | seal ทุก 30 นาที (ใส่ quote — มีช่องว่าง) |
| `SEAL_BATCH_SIZE` | `500` | 30 นาที × 300 log/ชม. = 150 log → 1 tx ต่อรอบ (ดู docs/bench-anchor.md) |
| `SEAL_MIN_BALANCE_TX` | `5` | ยอดไม่พอจ่าย storeRoot 5 ครั้ง → ไม่สร้าง batch + alert `WALLET_LOW_BALANCE` |
| `BLOCKCHAIN_EXPLORER_TX_URL` | `https://amoy.polygonscan.com/tx/` | ลิงก์ `polygonscanUrl` |
| `PRICE_POL_ETH` | `0.0000419` | มูลค่า POL → ETH ใน `/batches/:id/tree` (ไม่ใช่ gas บน Ethereum) |
| `PRICE_POL_THB` | `3.32` | มูลค่า POL → บาท |
| `PRICE_AS_OF` | `2026-10-15` | วันที่ของราคา (แสดงใน `cost.rates.asOf`) |

ที่มาของราคา (2026-10-15): POL ≈ $0.0989 (MetaMask, 14 ต.ค.) · ETH ≈ $2,362.68 (MetaMask, 15 ต.ค.) · USD/THB ≈ 33.566 (Pluang mid-market, 15 ต.ค.)
→ POL/ETH = 0.0989 / 2362.68 ≈ 0.0000419 · POL/THB = 0.0989 × 33.566 ≈ 3.32 · **อัปเดตเองเมื่อราคาเปลี่ยน** (ไม่ดึงสด)
POL บน Amoy เป็น testnet ไม่มีมูลค่าจริง — ตัวเลขนี้คือ "ถ้าจ่ายด้วย POL จริงจะเท่าไร"

ค่าที่มีอยู่แล้วและต้องถูก: `BLOCKCHAIN_RPC_URL` (Amoy) · `CONTRACT_ADDRESS` · `BLOCKCHAIN_MAX_PRIORITY_FEE_GWEI=50`
ค่าอื่นของ `SEAL_*` ไม่ต้องตั้ง (default: backoff หลังล้ม 3 ครั้ง, เพดาน 60 รอบ, alert ยอดต่ำทุก 60 นาที)

## 3. ตรวจก่อนเปิด

```bash
docker exec logchain-postgres psql -U logchain -d logchain -Atc \
  "select (select count(*) from logs), (select count(*) from log_batch_mapping), (select count(*) from kafka_pending_logs)"
#   total = mapped (ไม่มี log ค้าง) — ตอนซ้อม 338|338|0
# nonce ของ wallet ไว้เทียบทีหลัง (อ่านอย่างเดียว)
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionCount","params":["<WALLET>","latest"]}' "$BLOCKCHAIN_RPC_URL"
```

log ค้าง = รอบ seal ถัดไป (:00 / :30) จะส่ง tx จริง — ตั้งใจหรือไม่ ตัดสินก่อนเปิด

## 4. build + เปิด (เฉพาะ backend กับ detection-consumer)

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose build backend detection-api   # detection-api = ตัว build image logchain-detection:dev
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --no-deps backend
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose up -d --no-deps --force-recreate detection-consumer
```

- `--no-deps`: ไม่ให้ compose สร้าง `vault-init` ใหม่ (`.env` เปลี่ยน = config hash เปลี่ยน) — ไม่ต้อง seed Vault ซ้ำ
- `detection-consumer` ไม่มี `build:` ของตัวเอง ใช้ image ร่วมกับ `detection-api` — build ที่ `detection-api` แล้ว recreate consumer
  (ตอนซ้อม build แค่ `detection-consumer` แล้ว image ไม่เปลี่ยน — กับดัก)
- `detection-api` (ตัว DeepLog/IsoForest) ไม่ต้อง recreate รอบนี้ — rule อยู่ใน consumer

## 5. ตรวจหลังเปิด

```bash
curl -sf localhost:3000/health
docker logs logchain-backend 2>&1 | grep -E "Seal schedule|Blockchain connected"
#   Seal schedule: "0 */30 * * * *" · batch size 500 · Blockchain connected: … contract=0x…
docker exec logchain-postgres psql -U logchain -d logchain -Atc "select name from migrations order by id" | tail -3
#   AlertLogs1790726400000 · BatchLogSnapshot1790812800000 · BatchGasAndIndexes1790899200000
docker exec logchain-detection-consumer python -c \
  "from app.rules import RuleEngine; e=RuleEngine(); print(len(e.rules), e.rules[0]['threshold'].get('distinct_by'))"
#   9 \bport (\d+)\b
```

รอ verify cron ≥ 2 รอบ (ทุกนาที) แล้ว:
- batch เดิมยัง CONFIRMED ครบ (ตอนซ้อม 52) · ไม่มี alert ใหม่ · nonce เท่าเดิม (ไม่มี tx)

## 6. gas ย้อนหลัง

```bash
node scripts/backfill-batch-gas.mjs            # dry-run (READ ONLY) — ดูจำนวนที่จะเติม
node scripts/backfill-batch-gas.mjs --apply    # เขียนแค่ gas_used / effective_gas_price ที่ยัง NULL
```

ตอนซ้อม: 47/52 แถว · 5 ใบ (seal 12–18 ก.ย.) public RPC ไม่มี history ของ tx → ข้าม (tx_hash ถูกต้อง — ดู docs/bench-anchor.md)

## 7. smoke test ผ่าน API (token จริง)

token: `log-ingestor` (client_credentials) / user ทดสอบ analyst / auditor (PKCE แบบ `scripts/check-rbac-live.py`)

| คำขอ | ต้องได้ (ตอนซ้อม) |
|---|---|
| `GET /batches?limit=2&status=CONFIRMED` (auditor) | `{items,total:52,…}` · `hasSnapshot:false` (batch เก่า) |
| `GET /batches/<id>/tree` (analyst) | `rootMatchesDb:true` · `chainRoot == dbRoot` · `cost.gasUsed` มีค่า (78,144) · `polygonscanUrl` Amoy · `rates.asOf` |
| `GET /batches/<id>/diff` (auditor) batch เก่า | `legacy:true` · `verdict:"INTACT"` |
| `GET /logs?limit=3` (analyst) | `{items,total:338}` · item มี `batchStatus` / `blockNumber` / `polygonscanUrl` |
| `GET /logs/<id>/detail` (auditor) | `proof.verified:true` · `chainCheck.match:true` (อ่านจาก Amoy สด) |

## 8. ปิด (ถ้าเป็นการซ้อม) / ย้อนกลับ

```bash
docker stop logchain-backend logchain-detection-consumer
```

ย้อนกลับเต็ม: `cp ~/logchain-env-backup-<D>.env .env` → checkout commit ก่อน deploy → build + up ใหม่
migration ใหม่ทั้ง 3 ตัวเพิ่มคอลัมน์/ตาราง/index อย่างเดียว ไม่ลบอะไร — backend รุ่นเก่าอ่าน DB นี้ได้ (คอลัมน์ใหม่ถูกเมิน)
ถ้าต้องถอย schema จริง: restore จาก `~/logchain-backup-<D>.sql` (ไม่ใช้ migration down บน DB ที่มีข้อมูล)
