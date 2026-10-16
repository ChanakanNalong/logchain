# API — logs, log detail, alerts (branch `feature/log-onchain-status`)

สัญญา JSON สำหรับทำ mock ฝั่ง frontend · prefix ทุกตัว `/api/v1` · auth = Bearer token ของ Keycloak
ทุก request ถูกบันทึกลง `audit_access` โดย `AuditMiddleware` (รวมคำขอที่ได้ 401/403/404)

ค่าในตัวอย่างเป็นของสมมติแต่รูปแบบตรงกับของจริง:
- `id` ทุกตัวเป็น UUID เต็ม · เวลาเป็น ISO-8601 UTC
- `merkleRoot` / `rawHash` เป็น hex 64 ตัว **ไม่มี** `0x` · `chainRoot` / `dbRoot` / `proof[].data` มี `0x`
- `blockNumber` เป็นตัวเลข (ไม่ใช่ string)
- `polygonscanUrl` = `BLOCKCHAIN_EXPLORER_TX_URL` + `txHash` (default `https://amoy.polygonscan.com/tx/`) · ไม่มี tx หรือตั้ง explorer เป็นค่าว่าง (Hardhat) = `null`

สถานะ batch: `PENDING` `SEALED` `UNVERIFIED` `CONFIRMED` `TAMPERED` `FAILED` · `batchStatus: null` = log ยังไม่ถูก seal

---

## 1. `GET /logs` — รายการ log + สถานะบน chain

role: `analyst` `operator` `admin`

| query | ชนิด | default | หมายเหตุ |
|---|---|---|---|
| `limit` | int 1–1000 | 100 | เกิน/ต่ำกว่าช่วง = 400 |
| `offset` | int ≥ 0 | 0 | |
| `source` | string | – | คั่นด้วย `,` ได้หลายค่า (OR) · ตรงตัว |
| `severity` | string | – | คั่นด้วย `,` ได้หลายค่า · `INFO` `WARNING` `HIGH` `CRITICAL` … |
| `eventType` | string | – | คั่นด้วย `,` ได้หลายค่า |
| `q` | string ≤ 200 | – | ค้นใน `message` แบบ ILIKE (ไม่สนตัวพิมพ์ · `%` `_` ถูกตีเป็นตัวอักษรธรรมดา) |

เรียง `createdAt` ใหม่→เก่า · filter คนละตัวเป็น AND

> ⚠️ **เปลี่ยนจากเดิม:** เดิมคืน array เปล่า ๆ · ตอนนี้คืน object ที่มี `items` — หน้า Logs / Verify / Dashboard เดิม
> (`api.get("/logs")`) จะพังจนกว่า frontend จะเปลี่ยนไปอ่าน `.items`

`GET /api/v1/logs?limit=2&offset=0&source=vps-01,web-01&q=failed`

```json
{
  "items": [
    {
      "id": "6f1c2b9e-3d4a-4f6b-9a1e-2c7d8e9f0a1b",
      "createdAt": "2026-10-15T09:41:07.512Z",
      "source": "vps-01",
      "sourceIp": "203.0.113.5",
      "eventType": "SYSLOG",
      "severity": "WARNING",
      "message": "Failed password for root from 203.0.113.xxx port 52314 ssh2",
      "classification": "INTERNAL",
      "cdeScope": false,
      "retentionDays": 365,
      "rawHash": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
      "batchId": null,
      "batchStatus": null,
      "txHash": null,
      "blockNumber": null,
      "polygonscanUrl": null
    },
    {
      "id": "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
      "createdAt": "2026-10-15T09:39:58.004Z",
      "source": "web-01",
      "sourceIp": "198.51.100.9",
      "eventType": "WEB_REQUEST",
      "severity": "INFO",
      "message": "POST /login 401 failed login for user jdoe",
      "classification": "INTERNAL",
      "cdeScope": false,
      "retentionDays": 365,
      "rawHash": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d",
      "batchId": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
      "batchStatus": "CONFIRMED",
      "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
      "blockNumber": 28451107,
      "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7"
    }
  ],
  "total": 37,
  "limit": 2,
  "offset": 0
}
```

`400` (query ผิด) — รูปแบบ error มาตรฐานของ Nest ValidationPipe:

```json
{ "message": ["limit must not be greater than 1000"], "error": "Bad Request", "statusCode": 400 }
```

---

## 2. `GET /logs/:id` — log ตัวเดียว (ไม่มีข้อมูล chain)

role: `analyst` `operator` `admin` · `:id` ต้องเป็น UUID เต็ม

```json
{
  "id": "6f1c2b9e-3d4a-4f6b-9a1e-2c7d8e9f0a1b",
  "source": "vps-01",
  "sourceIp": "203.0.113.5",
  "eventType": "SYSLOG",
  "severity": "WARNING",
  "message": "Failed password for root from 203.0.113.xxx port 52314 ssh2",
  "rawHash": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
  "classification": "INTERNAL",
  "retentionDays": 365,
  "cdeScope": false,
  "createdAt": "2026-10-15T09:41:07.512Z"
}
```

```json
{ "message": "Log not found", "error": "Not Found", "statusCode": 404 }
```
```json
{ "message": "Log ID must be a full UUID", "error": "Bad Request", "statusCode": 400 }
```
(เดิม: ไม่เจอ = 200 body ว่าง · id ไม่ใช่ UUID = 500)

---

## 3. `GET /logs/:id/detail` — log + batch + proof + alert + ตรวจกับ chain สด

role: `analyst` `operator` `admin` `auditor` · 404 / 400 เหมือนข้อ 2

`chainCheck` อ่าน root จาก contract (`getRoot` = eth_call ไม่เสีย gas) ทุกครั้งที่เรียก แล้วเทียบกับ root ใน DB
- `match: true` = root บน chain ตรงกับ DB · `false` = ไม่ตรง หรือยังไม่มี root บน chain (`chainRoot` เป็น 0x000…)
- RPC ล่ม / timeout (5 วิ) / ไม่ได้ตั้ง chain → `{ "error": "...", "checkedAt": ... }` (ยังได้ 200)
- `proof.verified` = proof ของ log นี้ประกอบกลับเป็น `batch.merkleRoot` ได้ (เทียบกับ DB ไม่ใช่ chain — chain ดูที่ `chainCheck`)

### 3a. seal + anchor แล้ว

```json
{
  "log": {
    "id": "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",
    "createdAt": "2026-10-15T09:39:58.004Z",
    "source": "web-01",
    "sourceIp": "198.51.100.9",
    "eventType": "WEB_REQUEST",
    "severity": "INFO",
    "message": "POST /login 401 failed login for user jdoe",
    "classification": "INTERNAL",
    "cdeScope": false,
    "retentionDays": 365,
    "rawHash": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d"
  },
  "batch": {
    "id": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
    "status": "CONFIRMED",
    "merkleRoot": "dfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
    "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
    "blockNumber": 28451107,
    "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
    "sealedAt": "2026-10-15T09:40:00.031Z",
    "confirmedAt": "2026-10-15T09:40:06.880Z"
  },
  "proof": {
    "verified": true,
    "path": [
      { "position": "right", "data": "0x5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b" },
      { "position": "left", "data": "0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d" }
    ]
  },
  "alerts": [
    {
      "id": "8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b",
      "alertType": "RULE_MATCH",
      "ruleId": "5710",
      "severity": "CRITICAL",
      "title": "Multiple authentication failures (brute force)",
      "status": "OPEN",
      "sourceIp": "198.51.100.9",
      "occurrenceCount": 3,
      "createdAt": "2026-10-15T09:40:02.117Z",
      "lastSeenAt": "2026-10-15T09:40:31.950Z",
      "role": "window"
    }
  ],
  "chainCheck": {
    "chainRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
    "dbRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
    "match": true,
    "checkedAt": "2026-10-15T09:52:13.402Z"
  }
}
```

`alerts[].role` = log นี้เกี่ยวกับ alert ยังไง (ดูข้อ 4) · alert เก่าที่สร้างก่อนมีตาราง `alert_logs` จะโผล่ด้วย role `trigger` ถ้า `alerts.log_id` ชี้มาที่ log นี้

### 3b. ยังไม่ seal

```json
{
  "log": { "id": "6f1c2b9e-3d4a-4f6b-9a1e-2c7d8e9f0a1b", "createdAt": "2026-10-15T09:41:07.512Z", "source": "vps-01", "sourceIp": "203.0.113.5", "eventType": "SYSLOG", "severity": "WARNING", "message": "Failed password for root from 203.0.113.xxx port 52314 ssh2", "classification": "INTERNAL", "cdeScope": false, "retentionDays": 365, "rawHash": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b" },
  "batch": null,
  "proof": null,
  "alerts": [],
  "chainCheck": null
}
```

### 3c. seal แล้วแต่ RPC ล่ม

```json
{
  "log": { "...": "เหมือน 3a" },
  "batch": { "...": "เหมือน 3a" },
  "proof": { "verified": true, "path": [] },
  "alerts": [],
  "chainCheck": {
    "error": "could not read root from chain: request timed out after 5000ms",
    "checkedAt": "2026-10-15T09:52:13.402Z"
  }
}
```

batch ที่ seal แบบไม่ anchor (`SEALED`, ไม่มี `txHash`) ยังเช็ค chain — `match: false` + `chainRoot` เป็นศูนย์ = ยังไม่ถูกตรึงบน chain

---

## 4. `GET /alerts/:id` — alert + log ทั้งหมดที่เกี่ยวข้อง

role: `analyst` `operator` `admin` · `:id` ต้องเป็น UUID (400) · ไม่เจอ = 404 `{"message":"Alert not found","error":"Not Found","statusCode":404}`

`logs[].role`:
| role | ความหมาย |
|---|---|
| `trigger` | log ที่ทำให้ alert ถูกสร้าง (= `alert.logId`) |
| `window` | log อื่นในหน้าต่างเวลาของ threshold rule (เช่น 4 ครั้งก่อนหน้าของ 5710) |
| `prior` | log ของ rule ก่อนหน้าในกฎแบบ chain (5715 → log ของ 5710) |
| `repeat` | log ที่เกิดซ้ำหลังจากนั้นระหว่างที่ alert ยัง OPEN (`occurrenceCount` เพิ่ม) |

log หนึ่งตัวมี role เดียวต่อ alert (ตัวแรกที่ผูก: trigger > window > prior > repeat) · เรียงตาม role แล้วตาม `createdAt`

```json
{
  "alert": {
    "id": "8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b",
    "logId": "11111111-2222-4333-8444-555555555555",
    "batchId": null,
    "alertType": "RULE_MATCH",
    "ruleId": "5710",
    "severity": "CRITICAL",
    "source": "vps-01",
    "sourceIp": "203.0.113.5",
    "title": "Multiple authentication failures (brute force)",
    "detail": {
      "rule_id": 5710,
      "reason": "Multiple authentication failures (brute force)",
      "confidence": null,
      "sequence_length": null,
      "log_message": "Failed password for root from 203.0.113.xxx port 52318 ssh2",
      "event_type": "SYSLOG",
      "ip_intel": { "ip": "203.0.113.5", "reputation": { "available": false } }
    },
    "status": "OPEN",
    "occurrenceCount": 2,
    "createdAt": "2026-10-15T09:40:02.117Z",
    "lastSeenAt": "2026-10-15T09:40:31.950Z",
    "lastNotifiedAt": "2026-10-15T09:40:02.117Z"
  },
  "logs": [
    { "id": "11111111-2222-4333-8444-555555555555", "role": "trigger", "message": "Failed password for root from 203.0.113.xxx port 52318 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:40:01.900Z", "batchStatus": "CONFIRMED" },
    { "id": "aaaaaaaa-0000-4000-8000-000000000001", "role": "window", "message": "Failed password for root from 203.0.113.xxx port 52314 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:39:57.100Z", "batchStatus": "CONFIRMED" },
    { "id": "aaaaaaaa-0000-4000-8000-000000000002", "role": "window", "message": "Failed password for root from 203.0.113.xxx port 52315 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:39:58.300Z", "batchStatus": "CONFIRMED" },
    { "id": "aaaaaaaa-0000-4000-8000-000000000003", "role": "window", "message": "Failed password for root from 203.0.113.xxx port 52316 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:39:59.600Z", "batchStatus": "CONFIRMED" },
    { "id": "aaaaaaaa-0000-4000-8000-000000000004", "role": "window", "message": "Failed password for root from 203.0.113.xxx port 52317 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:40:00.800Z", "batchStatus": "CONFIRMED" },
    { "id": "aaaaaaaa-0000-4000-8000-000000000006", "role": "repeat", "message": "Failed password for root from 203.0.113.xxx port 52319 ssh2", "sourceIp": "203.0.113.5", "createdAt": "2026-10-15T09:40:31.700Z", "batchStatus": null }
  ]
}
```

---

## 5. `GET /alerts` — ไม่เปลี่ยนรูปแบบ (array) · แต่ละตัวมี `sourceIp` เพิ่ม

```json
[
  {
    "id": "8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b",
    "logId": "11111111-2222-4333-8444-555555555555",
    "batchId": null,
    "alertType": "RULE_MATCH",
    "ruleId": "5710",
    "severity": "CRITICAL",
    "source": "vps-01",
    "sourceIp": "203.0.113.5",
    "title": "Multiple authentication failures (brute force)",
    "detail": { "rule_id": 5710, "reason": "Multiple authentication failures (brute force)" },
    "status": "OPEN",
    "occurrenceCount": 2,
    "createdAt": "2026-10-15T09:40:02.117Z",
    "lastSeenAt": "2026-10-15T09:40:31.950Z",
    "lastNotifiedAt": "2026-10-15T09:40:02.117Z"
  }
]
```

**dedup เปลี่ยน:** alert ที่ยัง OPEN ถูกรวมเมื่อ (alertType, source, batchId, ruleId, **sourceIp**) ตรงกัน
→ 5710 จาก 2 IP บน source เดียวกัน = 2 แถว (เดิมรวมเป็นแถวเดียว)

---

## 6. `GET /stats/overview` — `batches.byStatus` มี `FAILED` เพิ่ม

```json
{ "batches": { "byStatus": { "CONFIRMED": 52, "SEALED": 0, "UNVERIFIED": 0, "TAMPERED": 0, "PENDING": 0, "FAILED": 2 } } }
```
(แสดงเฉพาะส่วนที่เปลี่ยน — field อื่นของ overview เหมือนเดิม)

---

## 6. `PATCH /alerts/:id/resolve` — ปิด alert พร้อม note (ไม่บังคับ)

`@Roles('operator', 'admin')` · body เป็น option:

```jsonc
{ "note": "false positive: UUID ใน URL ถูก mask เป็น [PAN]" }  // note ≤ 500 ตัวอักษร · ไม่ส่ง body ก็ได้
```

- เก็บผลลง `detail.resolution` (jsonb · ไม่มีคอลัมน์/migration ใหม่): `{ note, by, at }`
  - `by` = username จาก token (operator/admin ที่กดปิด) · `at` = ISO timestamp
  - ไม่ส่ง `note` มา = เก็บ note เดิมไว้ (resolve ซ้ำเพื่อ **เติม note ย้อนหลัง** ได้) · ส่ง `""` = ล้าง note
- เรียกซ้ำบน alert ที่ `RESOLVED` แล้วได้ — อัปเดต `detail.resolution` โดยไม่เปลี่ยน status
- คืน alert ใบที่อัปเดต (รวม `detail.resolution`)

**ถึง frontend:** แถว `RESOLVED` ที่ขยายให้แสดง `detail.resolution` เป็น "Resolved by `<by>` · `<at>` · `<note>`" · ปุ่ม Resolve เปิดช่องใส่ note (ไม่บังคับ) ก่อนยืนยัน

---

## หมายเหตุสำหรับ mock

- role ที่ไม่มีสิทธิ์ = `403 {"message":"Forbidden resource","error":"Forbidden","statusCode":403}` · ไม่มี token = 401
- `GET /logs/:id/detail` ช้ากว่า endpoint อื่น (อ่าน chain สด ≤ 5 วิ) — ควรมี loading state แยกของ `chainCheck`
- `alerts` ใน detail ไม่แบ่งหน้า (log หนึ่งตัวผูกกับ alert ไม่กี่ใบ) · `logs` ใน `GET /alerts/:id` ไม่แบ่งหน้าเช่นกัน
  (threshold window ≤ 100 แถว + repeat)

---

## หมายเหตุสำหรับ frontend: log จริงจาก VPS (forwarder/)

ค่า `source` ที่ forwarder ส่ง (ใช้ทำ filter / ปุ่ม "Real logs" — `GET /logs?source=vps-sshd,web-proxy`):

| source | eventType | คืออะไร |
|---|---|---|
| `vps-sshd` | `SSH_AUTH` | sshd ของเครื่อง (Invalid user / Failed password / Accepted … / Connection closed …) — Accepted = `INFO` นอกนั้น `WARNING` |
| `web-proxy` | `HTTP_ACCESS` | access log ของ https-proxy (Caddy) **ทุก request** ยกเว้น static asset / health check / Uptime Kuma · request ปกติ = `INFO` · น่าสงสัย (scanner / traversal / SQLi / command injection / probe path) = `WARNING` · `message` = `METHOD PATH STATUS "UA"` (ค่า query ที่เป็นความลับของ request ปกติเป็น `***`) · `sourceIp` = IP จริงของผู้ใช้ |

(เดิมในร่างใช้ `vps-nginx` — เปลี่ยนเป็น `web-proxy` แล้ว ไม่มี log ที่ใช้ชื่อเดิม)

- **`sourceIp` เป็น IP เต็มของผู้เข้าเว็บ** (ไม่ mask) — เก็บไว้เพื่อความปลอดภัย (ระบุผู้โจมตี · rule นับแยกตาม IP)
  ส่วน IP ที่อยู่ใน `message` backend mask เป็น `x.x.x.xxx` ตามเดิม · หน้า UI แสดง `sourceIp` ได้เฉพาะ role ที่เห็น log อยู่แล้ว
- ตั้งแต่เปิด forwarder: `web-proxy` ราว 20 บรรทัด/ชม. ส่วนใหญ่ `INFO` — หน้า "Real logs" ควรมี filter `severity=WARNING`
  ไว้ดูเฉพาะที่น่าสงสัย (ค่าเริ่มแสดงทั้งหมดได้)

