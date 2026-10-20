# API — Merkle tree ของ batch + ค่าใช้จ่าย (branch `feature/merkle-tree-api`)

สัญญา JSON สำหรับหน้า Verify ฝั่ง frontend · prefix `/api/v1` · Bearer token ของ Keycloak · ทุกคำขอลง `audit_access`
ค่าในตัวอย่างคำนวณจริงด้วย merkletreejs แบบเดียวกับ backend (hash ถูกต้องตรงกัน ใช้ทดสอบ UI ได้) · log id / tx เป็นของสมมติ

รูปแบบ: hash ทุกตัวในไฟล์นี้มี `0x` ยกเว้น `rawHash` และ `batch.merkleRoot` ใน proof (hex 64 ไม่มี `0x` เหมือน endpoint อื่น)
**ตัวเลขเงิน/gas ทุกตัวเป็น string ทศนิยม** (ไม่ใช่ float · ไม่มี 1e-7) — แสดงตรง ๆ หรือใช้ไลบรารี decimal ถ้าจะคำนวณต่อ

---

## 1. `GET /batches/:id/tree`

role: `analyst` `operator` `auditor` `admin` · `:id` ต้องเป็น UUID (400) · ไม่มี batch = 404

สร้างจาก `MerkleService` ตัวเดียวกับที่ seal / verify ใช้ (`getLayers()` ของ merkletreejs) จาก log ที่ผูกกับ batch ตอนนี้

| field | ความหมาย |
|---|---|
| `leaves[]` | `index` (0-based) · `logId` · `rawHash` (raw_hash ที่เก็บไว้) · `leafHash` = sha256(utf8 ของ rawHash) · `contentHash` = hash คำนวณใหม่จากเนื้อหาปัจจุบัน (ต่างจาก `rawHash` = เนื้อถูกแก้) — เรียง `createdAt` ASC, `id` ASC |
| `layers` | tree จาก **raw_hash ที่เก็บไว้** (storedHashRoot) · `layers[0]` = leafHash ทั้งหมด … `layers[last]` = `[root]` · ในชั้นเดียวกัน node `2k` กับ `2k+1` รวมกันเป็น node `k` ของชั้นถัดไป (คู่ถูกเรียงก่อน hash — `sortPairs`) |
| `promoted[]` | node เศษ (ชั้นที่มีจำนวนคี่ ตัวสุดท้าย) ที่ **ส่งต่อขึ้นไปเฉย ๆ ไม่ hash** · `{layer, index}` = ตำแหน่งในชั้นนั้น → ไปอยู่ชั้น `layer+1` ตำแหน่ง `floor(index/2)` ค่าเดิม |
| `snapshotRoot` | root จาก snapshot ตอน seal · `null` = batch เก่าก่อนมี snapshot |
| `storedHashRoot` | root จาก leaf = `raw_hash` ที่เก็บไว้ (ได้จาก `layers`) · `storedHashRootMatchesDb` = เท่ากับ `dbRoot` ไหม · **แดงเมื่อคอลัมน์ `raw_hash` ถูกแก้** |
| `contentRoot` | root จาก leaf = hash **คำนวณใหม่จากเนื้อหา log ปัจจุบัน** (version-aware) · `contentRootMatchesDb` = เท่ากับ `dbRoot` ไหม · **แดงเมื่อเนื้อ log ถูกแก้** (เดิม `computedRoot` ตัวเดียวใช้ raw_hash จึงเขียวทั้งที่เนื้อถูกแก้) · batch ที่ไม่ถูกแตะ: `storedHashRoot` = `contentRoot` = `dbRoot` |
| `chainRoot` | อ่านจาก contract (eth_call) · RPC ล่ม / ไม่ได้ตั้ง chain → `null` + `chainError` (ยัง 200) · ยังไม่ anchor = `0x000…` |
| `cost` | `null` ถ้า batch ไม่มี `gas_used` (ยังไม่ anchor / ROOT_EXISTS / batch เก่าที่ยังไม่ backfill) |

`cost`:
- `batchCostPol` = gas_used × effective_gas_price · `perLogCostPol` = batchCostPol / logCount
- `oneTxPerLogCostPol` = logCount × batchCostPol (ถ้า anchor ทีละ log — gas ต่อ tx คงที่ ดู docs/bench-anchor.md) · `savingFactor` = logCount
- `eth` / `thb` = มูลค่า POL แปลงตามราคาตลาด (`PRICE_POL_ETH`, `PRICE_POL_THB` ใน env) — **ไม่ใช่ค่า gas ถ้าไปรันบน Ethereum**
  ไม่ได้ตั้ง rate ตัวไหน → object นั้นเป็น `null` และ `rates.polEth` / `rates.polThb` เป็น `null`
- `rates.asOf` = `PRICE_AS_OF` (วันที่ของราคา ผู้ดูแลกรอกเอง) · `rates.source` = `"config"` เสมอ (ไม่ได้ดึงราคาสด)

### 1a. 5 log (มีเศษ 2 ชั้น) · anchor แล้ว · ตั้ง rate ครบ

```json
{
  "batchId": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
  "status": "CONFIRMED",
  "logCount": 5,
  "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "blockNumber": 28451107,
  "polygonscanUrl": "https://amoy.polygonscan.com/tx/0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
  "dbRoot": "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
  "snapshotRoot": "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
  "storedHashRoot": "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
  "storedHashRootMatchesDb": true,
  "contentRoot": "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
  "contentRootMatchesDb": true,
  "chainRoot": "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
  "chainError": null,
  "checkedAt": "2026-10-15T10:20:11.402Z",
  "leaves": [
    {
      "index": 0,
      "logId": "aaaaaaaa-0000-4000-8000-000000000000",
      "rawHash": "663555dd495b3e9d76ff29dfb4be2e42f688ec06e9449fd8b85175077ee2de6a",
      "leafHash": "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760"
    },
    {
      "index": 1,
      "logId": "aaaaaaaa-0000-4000-8000-000000000001",
      "rawHash": "c46928bc87de23b9a8bd235aa1fe67ccb1542c8389ad3f02bf4ab5cff506e98f",
      "leafHash": "0x64efdee6fda4af87f92f61c14eb27edecc7e7afd87f73a5928e6c98517d50482"
    },
    {
      "index": 2,
      "logId": "aaaaaaaa-0000-4000-8000-000000000002",
      "rawHash": "73aaa5071d9f861550d51469cbd89e0a6e5371486fd94c9675281d1cefbd5117",
      "leafHash": "0x1167831cc42e2be233dec14023ff2b922b81c94a7c6efd126fc8dbb801316041"
    },
    {
      "index": 3,
      "logId": "aaaaaaaa-0000-4000-8000-000000000003",
      "rawHash": "f25743e01a8d2faa127a86adc728bf034cb23a158ec792ee9a43c5c2cfad4aab",
      "leafHash": "0x31bd53d6def13ef28a9a5cd0317e9813f30e2b0eeb78c0a2a2bcda4834754626"
    },
    {
      "index": 4,
      "logId": "aaaaaaaa-0000-4000-8000-000000000004",
      "rawHash": "23d547881cbc4d044f05ff1831d93f8128ca116bb96f1404722aaed6821668b3",
      "leafHash": "0x317a161c46e864b8cee8b40d1d1b3af9319e2914729e90582c65dcd6764b519c"
    }
  ],
  "layers": [
    [
      "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760",
      "0x64efdee6fda4af87f92f61c14eb27edecc7e7afd87f73a5928e6c98517d50482",
      "0x1167831cc42e2be233dec14023ff2b922b81c94a7c6efd126fc8dbb801316041",
      "0x31bd53d6def13ef28a9a5cd0317e9813f30e2b0eeb78c0a2a2bcda4834754626",
      "0x317a161c46e864b8cee8b40d1d1b3af9319e2914729e90582c65dcd6764b519c"
    ],
    [
      "0x92c6ed8d09bbd3858778cd7c1a21c2bc3abe191b033ae7486ed71bf0fd027fa5",
      "0x23170049652543a06f60a26214fb18ded4709df370ce619af0b3e05209d9a86d",
      "0x317a161c46e864b8cee8b40d1d1b3af9319e2914729e90582c65dcd6764b519c"
    ],
    [
      "0x50b9fceb16188a68eb015704e43c33bbde01b5f7333569ec8dbd00368c7d870e",
      "0x317a161c46e864b8cee8b40d1d1b3af9319e2914729e90582c65dcd6764b519c"
    ],
    [
      "0x87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da"
    ]
  ],
  "promoted": [
    {
      "layer": 0,
      "index": 4
    },
    {
      "layer": 1,
      "index": 2
    }
  ],
  "cost": {
    "gasUsed": "78156",
    "effectiveGasPriceGwei": "50",
    "batchCostPol": "0.0039078",
    "perLogCostPol": "0.00078156",
    "oneTxPerLogCostPol": "0.019539",
    "savingFactor": "5",
    "eth": {
      "batch": "0.0000002442375",
      "perLog": "0.0000000488475",
      "oneTxPerLog": "0.0000012211875"
    },
    "thb": {
      "batch": "0.03067623",
      "perLog": "0.006135246",
      "oneTxPerLog": "0.15338115"
    },
    "rates": {
      "polEth": "0.0000625",
      "polThb": "7.85",
      "asOf": "2026-10-15",
      "source": "config"
    }
  }
}
```

ชั้น 0 มี 5 ตัว → ตัวที่ 4 ขึ้นไปเป็นตัวที่ 2 ของชั้น 1 · ชั้น 1 มี 3 ตัว → ตัวที่ 2 ขึ้นไปเป็นตัวที่ 1 ของชั้น 2 (ค่าเดิมทั้งสองครั้ง)

### 1b. 1 log

root = leafHash ของ log ตัวเดียว · `layers` มีชั้นเดียว · ไม่มี promoted

```json
{
  "leaves": [
    {
      "index": 0,
      "logId": "aaaaaaaa-0000-4000-8000-000000000000",
      "rawHash": "663555dd495b3e9d76ff29dfb4be2e42f688ec06e9449fd8b85175077ee2de6a",
      "leafHash": "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760"
    }
  ],
  "layers": [
    [
      "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760"
    ]
  ],
  "promoted": [],
  "dbRoot": "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760",
  "storedHashRoot": "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760",
  "storedHashRootMatchesDb": true,
  "contentRoot": "0x787cfb9f43cde9ee55795482bf87df214d9c4d65e46611f849fc7faf0159f760",
  "contentRootMatchesDb": true
}
```
(field อื่นเหมือน 1a · ทุก log ที่ไม่ถูกแตะ → `contentHash` ของ leaf = `rawHash` และ `contentRoot` = `storedHashRoot` = `dbRoot`)

### 1c. ไม่มี gas (ยังไม่ anchor / batch เก่า)

```json
{ "status": "SEALED", "txHash": null, "polygonscanUrl": null, "chainRoot": "0x0000000000000000000000000000000000000000000000000000000000000000", "chainError": null, "cost": null }
```

### 1d. ไม่ได้ตั้ง rate (`PRICE_POL_ETH` / `PRICE_POL_THB` ว่าง)

```json
{
  "cost": {
    "gasUsed": "78156",
    "effectiveGasPriceGwei": "50",
    "batchCostPol": "0.0039078",
    "perLogCostPol": "0.00078156",
    "oneTxPerLogCostPol": "0.019539",
    "savingFactor": "5",
    "eth": null,
    "thb": null,
    "rates": { "polEth": null, "polThb": null, "asOf": null, "source": "config" }
  }
}
```

### 1e. RPC ล่ม

```json
{ "chainRoot": null, "chainError": "could not read root from chain: request timed out after 5000ms" }
```
(ที่เหลือคำนวณจาก DB ตามปกติ · 200)

### 1f. error

```json
{ "message": "Batch not found", "error": "Not Found", "statusCode": 404 }
```
```json
{ "message": "Batch ID must be a UUID", "error": "Bad Request", "statusCode": 400 }
```
```json
{ "message": "Forbidden resource", "error": "Forbidden", "statusCode": 403 }
```
(`ingestor`)

---

## 2. `GET /logs/:id/proof` — leaf = `sha256(contentHash)` · เพิ่ม `contentHash` + `integrity`

role เดิม (`analyst` `operator` `admin`) · `leafIndex` ตรงกับ `leaves[].index` ของ tree

**leaf คำนวณจากเนื้อหาปัจจุบัน** (`contentHash`) ไม่ใช่ `raw_hash` ที่เก็บไว้ (`rawHash`) — แก้เนื้อ log แล้ว `contentHash` เปลี่ยน → leaf เปลี่ยน → `verify: false` (เดิมใช้ raw_hash จึง true ทั้งที่เนื้อถูกแก้)
- `rawHash` = raw_hash ที่เก็บใน DB · `contentHash` = hash คำนวณใหม่จากเนื้อหาปัจจุบัน · ต่างกัน = ถูกแก้
- `integrity`: `INTACT` · `CONTENT_MODIFIED` (เนื้อ log ถูกแก้) · `HASH_MODIFIED` (คอลัมน์ raw_hash ถูกแก้ เนื้อหาเดิม) · `UNKNOWN` (legacy ไม่มี snapshot) — แยกด้วย snapshot

ตรวจเองได้: เริ่มจาก `leafHash` (= sha256 ของ `contentHash`) แล้วไล่ `proof` — `position: "left"` = sibling อยู่ซ้าย · ก่อน hash ให้เรียงคู่ (`sortPairs`) แล้ว sha256 ของ 2 ค่าต่อกัน
ได้ `0x` + `batch.merkleRoot` = proof ถูก (`verify: true`)

```json
{
  "logId": "aaaaaaaa-0000-4000-8000-000000000003",
  "rawHash": "f25743e01a8d2faa127a86adc728bf034cb23a158ec792ee9a43c5c2cfad4aab",
  "contentHash": "f25743e01a8d2faa127a86adc728bf034cb23a158ec792ee9a43c5c2cfad4aab",
  "integrity": "INTACT",
  "leafIndex": 3,
  "leafHash": "0x31bd53d6def13ef28a9a5cd0317e9813f30e2b0eeb78c0a2a2bcda4834754626",
  "batch": {
    "id": "c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c",
    "merkleRoot": "87e2e9e844ad922c3c2634f9e9dd4ec405a5e85d140ce51273a2fe3f8ca094da",
    "txHash": "0xfbe0b13c39a1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7",
    "blockNumber": 28451107,
    "status": "CONFIRMED"
  },
  "proof": [
    {
      "position": "left",
      "data": "0x1167831cc42e2be233dec14023ff2b922b81c94a7c6efd126fc8dbb801316041"
    },
    {
      "position": "left",
      "data": "0x92c6ed8d09bbd3858778cd7c1a21c2bc3abe191b033ae7486ed71bf0fd027fa5"
    },
    {
      "position": "right",
      "data": "0x317a161c46e864b8cee8b40d1d1b3af9319e2914729e90582c65dcd6764b519c"
    }
  ],
  "verify": true
}
```

log ตำแหน่ง 3 ของ 1a: proof ยาว 3 — ชั้น 0 คู่กับตัวที่ 2 · ชั้น 1 คู่กับตัวที่ 0 · ชั้น 2 คู่กับ node เศษ (ที่ส่งต่อมาจากตำแหน่ง 4) ได้ root
