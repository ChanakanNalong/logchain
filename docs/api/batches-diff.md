# API — batches + tamper diff (branch `feature/tamper-diff`)

สัญญา JSON สำหรับทำ mock ฝั่ง frontend · prefix `/api/v1` · Bearer token ของ Keycloak · ทุกคำขอลง `audit_access`

รูปแบบค่าเหมือน [logs-alerts.md](logs-alerts.md): UUID เต็ม · เวลา ISO-8601 UTC · `merkleRoot` hex 64 ไม่มี `0x`
· `chainRoot` / `snapshotRoot` / `dbRoot` / `currentRoot` มี `0x` · `polygonscanUrl` = `BLOCKCHAIN_EXPLORER_TX_URL` + `txHash` (ไม่มี tx = `null`)

---

## 1. `GET /batches` — รายการ batch (เปลี่ยนเป็นแบ่งหน้า)

role: `analyst` `operator` `auditor` `admin`

| query | ชนิด | default | หมายเหตุ |
|---|---|---|---|
| `limit` | int 1–100 | 10 | |
| `offset` | int ≥ 0 | 0 | |
| `status` | string | – | คั่นด้วย `,` ได้หลายค่า: `PENDING` `SEALED` `UNVERIFIED` `CONFIRMED` `TAMPERED` `FAILED` |

เรียง `sealedAt` ใหม่→เก่า

> ⚠️ **เปลี่ยนจากเดิม:** เดิมคืน array · ตอนนี้ `{ items, total, limit, offset }` (หน้า Verify เดิมแก้ให้อ่าน `.items` แล้ว)

`GET /api/v1/batches?limit=2&status=CONFIRMED,TAMPERED`

```json
{
  "items": [
    {
      "id": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
      "merkleRoot": "dfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
      "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
      "blockNumber": 28451107,
      "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
      "status": "TAMPERED",
      "logCount": 100,
      "sealedAt": "2026-10-15T09:40:00.031Z",
      "confirmedAt": "2026-10-15T09:40:06.880Z",
      "ifStatus": "active",
      "ifAnomaly": false,
      "ifScore": 0.0412,
      "ifReason": "within normal range",
      "ifScoredAt": "2026-10-15T09:40:00.410Z",
      "hasSnapshot": true
    },
    {
      "id": "6da0dd5e-cabb-4ca7-9ae6-faaa609c1421",
      "merkleRoot": "71f0962f0482de081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
      "txHash": "0xa059856557c4bbf7cdd21fcf4754b99ded7568cb3ffc9357df0ce1489a14e4e0",
      "blockNumber": 28120554,
      "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xa059856557c4bbf7cdd21fcf4754b99ded7568cb3ffc9357df0ce1489a14e4e0",
      "status": "CONFIRMED",
      "logCount": 7,
      "sealedAt": "2026-10-12T17:12:00.038Z",
      "confirmedAt": "2026-10-12T17:12:07.120Z",
      "ifStatus": "active",
      "ifAnomaly": null,
      "ifScore": null,
      "ifReason": null,
      "ifScoredAt": null,
      "hasSnapshot": false
    }
  ],
  "total": 53,
  "limit": 2,
  "offset": 0
}
```

`hasSnapshot: false` = batch ที่ seal ก่อนมี snapshot (52 ใบเดิม) → diff ได้แค่ระดับ batch (ข้อ 2f)

**Isolation Forest (ระดับที่ 3) · `ifStatus`:**
- `ifStatus: "active"` — โหมดปกติ (local) · `ifAnomaly` = ผลจำแนกจริง (`true`/`false`/`null`=ยังไม่จำแนก) · `ifScore`/`ifReason` มีค่า
- `ifStatus: "calibrating"` — โหมดเก็บข้อมูล (cloud, `IF_MODE=calibrating`) · **`ifAnomaly`/`ifScore`/`ifReason` เป็น `null` เสมอ**
  (backend ยัง score + เก็บผลไว้ retrain แต่ไม่เปิดเผยคำตัดสิน) · `ifScoredAt` ยังมีค่าบอกว่าประเมินแล้ว

```json
{ "ifStatus": "calibrating", "ifAnomaly": null, "ifScore": null, "ifReason": null, "ifScoredAt": "2026-10-16T04:17:06.000Z" }
```

> **ถึง Com:** ใช้ `ifStatus` ตัดสินการแสดง ไม่ใช่ `ifAnomaly` ตรง ๆ
> - `calibrating` → badge **สีเทา** "ML: calibrating" + tooltip "โมเดลฝึกจากข้อมูลจำลอง กำลังเก็บ traffic จริงเพื่อ retrain" · ห้ามแสดงแดง
> - `active` → เหมือนเดิม: `ifAnomaly===true` แดง "Anomaly" · `false` เขียว "Normal" · `null` "—"
> - cloud ตอนนี้เป็น `calibrating` (โมเดลฝึกจาก HDFS/ข้อมูลจำลอง · batch จริงเล็กจะถูก flag ผิดเกือบทุกใบ) จะสลับเป็น `active` หลัง retrain

`400` (query ผิด): `{ "message": ["limit must not be greater than 100"], "error": "Bad Request", "statusCode": 400 }`

---

## 2. `GET /batches/:id/diff` — log ตำแหน่งไหนถูกแก้ / ลบ / แทรก

role: `admin` `auditor` · `:id` ต้องเป็น UUID (400) · ไม่มี batch = 404

ตอน seal ระบบเก็บ **snapshot** ของทุก log ในชุด (เนื้อเดียวกับที่ hash + ตำแหน่งใน Merkle tree) ไว้ในตาราง write-only
diff เทียบ snapshot กับ log ปัจจุบันทีละตำแหน่ง — แต่ก่อนเชื่อ snapshot ต้องพิสูจน์ก่อนว่า snapshot เองไม่ถูกแก้:

1. `chainRoot` อ่านจาก contract (eth_call) · RPC ล่ม/ไม่ได้ตั้ง chain → `null` + `chainError`
2. `snapshotRoot` = root ที่สร้างจาก `raw_hash` ใน snapshot เรียงตามตำแหน่ง ต้อง = `chainRoot`
   (batch ที่ยังไม่ anchor หรืออ่าน chain ไม่ได้ เทียบกับ `dbRoot` แทน → `trustBasis: "db"`)
3. snapshot ทุกตัว: hash เนื้อใหม่ต้องได้ `raw_hash` ที่เก็บไว้
4. ผ่านทั้ง 2 ข้อ = `snapshotTrusted: true` → รายงานรายตำแหน่ง · ไม่ผ่าน = `false` → `changes: []` บอกได้แค่ระดับ batch

| ชนิด | ความหมาย | ข้อมูลที่ให้ |
|---|---|---|
| `CONTENT_MODIFIED` | เนื้อ log ปัจจุบันต่างจาก snapshot | `fields: [{field, before, after}]` รวม `rawHash` ถ้าเปลี่ยนด้วย |
| `HASH_MODIFIED` | เนื้อเหมือนเดิมแต่ `raw_hash` ถูกเปลี่ยน | `fields: [{field: "rawHash", before, after}]` |
| `DELETED` | มีใน snapshot แต่ row ใน `logs` หาย (`ROW_MISSING`) หรือ mapping หาย (`MAPPING_MISSING`) | `reason` + `snapshot` (เนื้อเดิมครบ) |
| `UNMAPPED_OR_INSERTED` | ผูกกับ batch นี้แต่ไม่มีใน snapshot | `current` (เนื้อปัจจุบัน) |
| `UNCHANGED` | ตรงกันทุกอย่าง | ไม่ใส่ใน `changes` (นับใน `summary.unchanged`) |

- `position` = ลำดับ leaf ใน Merkle tree เริ่มที่ **0** (ลำดับ seal: `createdAt`, `id`) · `UNMAPPED_OR_INSERTED` ใช้ลำดับในชุดที่ผูกอยู่ตอนนี้
- field ที่เทียบ: `source` `sourceIp` `eventType` `severity` `message` `classification` `cdeScope` `createdAt` + `rawHash`
- `currentRoot` = root ที่สร้างจาก log ปัจจุบันที่ผูกกับ batch (สิ่งที่ verify ทุกนาทีคำนวณ)
- `summary.verdict`: `INTACT` (ไม่มีอะไรเปลี่ยน root ตรง) · `TAMPERED` · `UNVERIFIABLE` (ไม่มี root อ้างอิงที่เชื่อได้ — RPC ล่มหลังส่ง tx แล้ว หรือ batch ยังไม่ขึ้น chain ดู 2i)

### 2a. ปกติ

```json
{
  "batchId": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
  "status": "CONFIRMED",
  "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "blockNumber": 28451107,
  "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "chainRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "chainError": null,
  "snapshotRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "dbRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "currentRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "snapshotTrusted": true,
  "trustBasis": "chain",
  "untrustedReasons": [],
  "legacy": false,
  "checkedAt": "2026-10-15T10:02:41.118Z",
  "summary": {
    "verdict": "INTACT",
    "snapshotLogs": 100,
    "mappedLogs": 100,
    "unchanged": 100,
    "contentModified": 0,
    "hashModified": 0,
    "deleted": 0,
    "unmappedOrInserted": 0
  },
  "changes": []
}
```

### 2b. แก้เนื้อ (ตำแหน่ง 55 · message)

ถ้าคนแก้คำนวณ `raw_hash` ใหม่ให้ตรงกับเนื้อที่แก้ด้วย จะมี `rawHash` อยู่ใน `fields` เพิ่ม — ยังจับได้เพราะ snapshot ผูกกับ root บน chain

```json
{
  "batchId": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
  "status": "TAMPERED",
  "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "blockNumber": 28451107,
  "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "chainRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "chainError": null,
  "snapshotRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "dbRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "currentRoot": "0x4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
  "snapshotTrusted": true,
  "trustBasis": "chain",
  "untrustedReasons": [],
  "legacy": false,
  "checkedAt": "2026-10-15T10:05:12.007Z",
  "summary": {
    "verdict": "TAMPERED",
    "snapshotLogs": 100,
    "mappedLogs": 100,
    "unchanged": 99,
    "contentModified": 1,
    "hashModified": 0,
    "deleted": 0,
    "unmappedOrInserted": 0
  },
  "changes": [
    {
      "position": 55,
      "logId": "aaaaaaaa-0000-4000-8000-000000000055",
      "type": "CONTENT_MODIFIED",
      "fields": [
        { "field": "message", "before": "Failed password for root from 203.0.113.xxx port 52355 ssh2", "after": "user jdoe opened the reports page" },
        { "field": "rawHash", "before": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", "after": "7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b3b1f0c5d9a7e4f2b8c6d1e0a9f8b" }
      ]
    }
  ]
}
```

### 2c. แก้แค่ `raw_hash` (แบบ `scripts/demo-tamper.sh`)

```json
{
  "changes": [
    {
      "position": 0,
      "logId": "aaaaaaaa-0000-4000-8000-000000000000",
      "type": "HASH_MODIFIED",
      "fields": [
        { "field": "rawHash", "before": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b", "after": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" }
      ]
    }
  ],
  "summary": { "verdict": "TAMPERED", "snapshotLogs": 100, "mappedLogs": 100, "unchanged": 99, "contentModified": 0, "hashModified": 1, "deleted": 0, "unmappedOrInserted": 0 }
}
```
(field อื่นเหมือน 2b)

### 2d. ลบ (ตำแหน่ง 55)

```json
{
  "changes": [
    {
      "position": 55,
      "logId": "aaaaaaaa-0000-4000-8000-000000000055",
      "type": "DELETED",
      "reason": "ROW_MISSING",
      "snapshot": {
        "id": "aaaaaaaa-0000-4000-8000-000000000055",
        "createdAt": "2026-10-15T09:39:58.004Z",
        "source": "vps-01",
        "sourceIp": "203.0.113.5",
        "eventType": "SYSLOG",
        "severity": "WARNING",
        "message": "Failed password for root from 203.0.113.xxx port 52355 ssh2",
        "classification": "INTERNAL",
        "cdeScope": false,
        "rawHash": "3b1f0c5d9a7e4f2b8c6d1e0a9f8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b"
      }
    }
  ],
  "summary": { "verdict": "TAMPERED", "snapshotLogs": 100, "mappedLogs": 99, "unchanged": 99, "contentModified": 0, "hashModified": 0, "deleted": 1, "unmappedOrInserted": 0 }
}
```
`reason: "MAPPING_MISSING"` = row ใน `logs` ยังอยู่แต่ถูกถอดออกจาก batch

### 2e. แทรก (log ที่ผูกกับ batch แต่ไม่อยู่ใน snapshot)

```json
{
  "changes": [
    {
      "position": 100,
      "logId": "bbbbbbbb-0000-4000-8000-000000000001",
      "type": "UNMAPPED_OR_INSERTED",
      "current": {
        "id": "bbbbbbbb-0000-4000-8000-000000000001",
        "createdAt": "2026-10-15T09:41:00.000Z",
        "source": "vps-01",
        "sourceIp": null,
        "eventType": "SYSLOG",
        "severity": "INFO",
        "message": "inserted later",
        "classification": "INTERNAL",
        "cdeScope": false,
        "rawHash": "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d"
      }
    }
  ],
  "summary": { "verdict": "TAMPERED", "snapshotLogs": 100, "mappedLogs": 101, "unchanged": 100, "contentModified": 0, "hashModified": 0, "deleted": 0, "unmappedOrInserted": 1 }
}
```

### 2f. snapshot ไม่น่าเชื่อถือ (snapshot เองถูกแก้)

```json
{
  "batchId": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
  "status": "TAMPERED",
  "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "blockNumber": 28451107,
  "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "chainRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "chainError": null,
  "snapshotRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "dbRoot": "0xdfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "currentRoot": "0x4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
  "snapshotTrusted": false,
  "trustBasis": "chain",
  "untrustedReasons": ["SNAPSHOT_CONTENT_MISMATCH"],
  "legacy": false,
  "checkedAt": "2026-10-15T10:07:30.551Z",
  "summary": {
    "verdict": "TAMPERED",
    "snapshotLogs": 100,
    "mappedLogs": 100,
    "unchanged": null,
    "contentModified": null,
    "hashModified": null,
    "deleted": null,
    "unmappedOrInserted": null
  },
  "changes": []
}
```

`untrustedReasons`: `SNAPSHOT_ROOT_MISMATCH` (root ของ snapshot ≠ root อ้างอิง) · `SNAPSHOT_CONTENT_MISMATCH` (เนื้อใน snapshot hash ไม่ได้ raw_hash ของมัน)
· `NOT_ANCHORED` (batch ไม่เคยขึ้น chain — ดู 2i · มาคู่กับ verdict `UNVERIFIABLE` เสมอ ไม่ได้แปลว่า snapshot ถูกแก้)
ระดับ batch ยังบอกได้จาก `currentRoot` เทียบ `chainRoot` · ตัวเลขรายตำแหน่งเป็น `null` (ไม่รู้)

### 2g. legacy (batch ที่ seal ก่อนมี snapshot)

```json
{
  "batchId": "6da0dd5e-cabb-4ca7-9ae6-faaa609c1421",
  "status": "CONFIRMED",
  "txHash": "0xa059856557c4bbf7cdd21fcf4754b99ded7568cb3ffc9357df0ce1489a14e4e0",
  "blockNumber": 28120554,
  "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xa059856557c4bbf7cdd21fcf4754b99ded7568cb3ffc9357df0ce1489a14e4e0",
  "chainRoot": "0x71f0962f0482de081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "chainError": null,
  "snapshotRoot": null,
  "dbRoot": "0x71f0962f0482de081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "currentRoot": "0x71f0962f0482de081a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081",
  "snapshotTrusted": null,
  "trustBasis": null,
  "untrustedReasons": [],
  "legacy": true,
  "checkedAt": "2026-10-15T10:08:02.913Z",
  "summary": {
    "verdict": "INTACT",
    "snapshotLogs": 0,
    "mappedLogs": 7,
    "unchanged": null,
    "contentModified": null,
    "hashModified": null,
    "deleted": null,
    "unmappedOrInserted": null
  },
  "changes": []
}
```

### 2h. RPC ล่ม

`chainRoot: null`, `chainError: "could not read root from chain: request timed out after 5000ms"`, `trustBasis: "db"` (เทียบ snapshot กับ `dbRoot`) · ที่เหลือคำนวณตามปกติ · ได้ 200 ไม่ใช่ 500

### 2i. ยังไม่ขึ้น chain (`NOT_ANCHORED`)

batch ที่ **ไม่มี `txHash`** + status `FAILED` / `SEALED` / `PENDING` + root บน chain เป็นศูนย์ (ไม่มี tx จริง) → ไม่มีอะไรอ้างอิงนอก DB
→ `verdict: "UNVERIFIABLE"` + `untrustedReasons` มี `"NOT_ANCHORED"` (ต่อท้ายเหตุผลอื่น ถ้ามี)

- `FAILED` = anchor ไม่สำเร็จ (เช่น wallet เงินหมด) → **ไม่เขียน mapping โดยตั้งใจ** log ชุดนั้นถูก seal ใหม่ใน batch ถัดไป
  → `mappedLogs: 0` · `currentRoot: null` (เดิมได้ `TAMPERED` ปลอมเพราะ `currentRoot` ≠ `dbRoot` เสมอ)
- `SEALED` / `PENDING` ที่ยังไม่มี tx: `changes` ยังคำนวณเทียบ snapshot กับ log ปัจจุบันให้ดู แต่ทั้งสองฝั่งอยู่ใน DB → verdict ยัง `UNVERIFIABLE`
- ไม่มี `txHash` ใน DB แต่ root อยู่บน chain แล้ว = anchor แล้ว → ตัดสินตามปกติ (ไม่ใส่ `NOT_ANCHORED`)
- batch `CONFIRMED` ที่ root ไม่ตรง → ยัง `TAMPERED` ตามเดิม

**ข้อจำกัด (ยังไม่แก้ — ตั้งใจ):** anchor สำเร็จแต่ commit ฝั่ง DB ล้ม (เช่น เขียน snapshot ไม่ได้) → batch เป็น `FAILED`
มี root จริงบน chain แต่ไม่มี mapping (log ชุดนั้นถูก seal ใหม่ใน batch ถัดไป) → ไม่เข้าเงื่อนไข `NOT_ANCHORED`
เพราะ chain มี root แล้ว → `currentRoot: null` ≠ `chainRoot` → ได้ **`TAMPERED`** ทั้งที่ log ไม่ได้ถูกแก้
เกิดได้เฉพาะ DB ล้มหลังส่ง tx (ไม่ใช่กรณีเงินหมด) · cloud ไม่มี batch แบบนี้ (FAILED 1,161 ใบไม่มี tx ทุกใบ) ·
ดูว่าใช่กรณีนี้ไหม: status `FAILED` + `mappedLogs: 0` + `chainRoot` ไม่เป็นศูนย์ · เทสต์: `test/tamper-diff.integration.spec.ts`
("a snapshot that cannot be written leaves no mapping")

```json
{
  "batchId": "ed34ebe2-a1b6-454a-98cf-971f08b020ed",
  "status": "FAILED",
  "txHash": null,
  "blockNumber": null,
  "polygonscanUrl": null,
  "chainRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "chainError": null,
  "snapshotRoot": null,
  "dbRoot": "0x3c5e9a1b7d2f4e6a8c0b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a",
  "currentRoot": null,
  "snapshotTrusted": null,
  "trustBasis": null,
  "untrustedReasons": ["NOT_ANCHORED"],
  "legacy": true,
  "checkedAt": "2026-10-16T03:28:27.700Z",
  "summary": {
    "verdict": "UNVERIFIABLE",
    "snapshotLogs": 0,
    "mappedLogs": 0,
    "unchanged": null,
    "contentModified": null,
    "hashModified": null,
    "deleted": null,
    "unmappedOrInserted": null
  },
  "changes": []
}
```

> **ถึง Com (หน้าตรวจ Batch):** cloud มี batch `FAILED` 1,161 ใบ (wallet เงินหมด 2026-10-08) ปนกับ `CONFIRMED` ราว 44 ใบ
> - **default ควรซ่อน `FAILED`** — เรียก `GET /batches?status=PENDING,SEALED,UNVERIFIED,CONFIRMED,TAMPERED` แล้วมี toggle "แสดง batch ที่ anchor ไม่สำเร็จ"
> - ถ้าแสดง: แถว/การ์ด **สีเทา** (ไม่ใช่สีแดง) พร้อมข้อความ **"anchor ไม่สำเร็จ ล็อกถูก seal ใน batch ถัดไป"** · ไม่ต้องมีปุ่ม polygonscan (`polygonscanUrl: null`)
> - หน้า diff: `untrustedReasons` มี `NOT_ANCHORED` → แสดงข้อความเดียวกัน แทนป้าย TAMPERED / UNVERIFIABLE สีแดง

### 2j. error

```json
{ "message": "Forbidden resource", "error": "Forbidden", "statusCode": 403 }
```
(`analyst` / `operator` / `ingestor` เรียก diff)

```json
{ "message": "Batch not found", "error": "Not Found", "statusCode": 404 }
```
```json
{ "message": "Batch ID must be a UUID", "error": "Bad Request", "statusCode": 400 }
```
