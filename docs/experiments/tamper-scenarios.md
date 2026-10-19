# การทดลอง tamper บน environment hh (Hardhat จริง)

> **สถานะ: ยังไม่ commit** · ทดลองบน environment hh เท่านั้น (Postgres hh พอร์ต 15433 + Hardhat node 127.0.0.1:8545 chainId 31337) · ไม่แตะ CT141 / Amoy · ไม่ส่ง tx จริงบนเน็ตเวิร์กจริง
>
> รันซ้ำได้ด้วย spec: `test/tamper-scenarios.integration.spec.ts`
> ```bash
> # ต้องมี: hardhat node ที่ 8545 (cd ~/Documents/logchain-contracts && npx hardhat node)
> #         hh-postgres+hh-vault ขึ้น + deploy contract (ENV_FILE=.env.hardhat node scripts/deploy-contract.mjs)
> ( set -a; . ./.env.hardhat; . .hardhat/vault-secrets/approle.env; set +a
>   NODE_ENV=test E2E_ALLOW_DB=127.0.0.1:15433 TAMPER_HH=1 \
>   npx jest --config test/jest-e2e.json test/tamper-scenarios.integration.spec.ts )
> ```
> spec จะ **skip เองใน CI** (และทุกที่ที่ไม่ได้ตั้ง `TAMPER_HH=1`) — เพราะ `ci.yml` รัน `jest-e2e` กับทุก `*.integration.spec.ts` โดยไม่มี Hardhat/CONTRACT_ADDRESS ถ้าไม่ skip จะทำ CI แดง
> auth: ใช้ test-roles guard แทน Keycloak **เฉพาะในชุดทดสอบนี้** (Keycloak realm ปิด `directAccessGrantsEnabled` ทุก client + admin บังคับ OTP จึงขอ token อัตโนมัติไม่ได้) — โค้ด controller/service/integrity/blockchain ทุกตัวเป็นของจริง · ไม่แก้โค้ด production · ไม่แก้ config Keycloak

## วิธีทดลอง

1. ingest 8 log (message/sourceIp ต่างกัน) → `POST /logs/seal-now` → `POST /logs/verify-now` → batch **CONFIRMED** (anchor จริงบน Hardhat) · batchId `27941835-…-ffe9cf8a30f6`
2. baseline: `dbRoot = computedRoot = chainRoot = 0x96cf68c4fb46…b423f5` · diff **INTACT** · proof ทุกตัว `verify=true`
3. backup แถว `logs` + `log_batch_mapping` ของ batch ลงไฟล์ก่อนแตะ (`scratchpad/tamper-results.backup.json`)
4. แต่ละสถานการณ์: ปิด trigger (`ALTER TABLE logs DISABLE TRIGGER …` + **ENABLE คืนใน finally เสมอ**) → แก้/ลบ/แทรก → `POST /logs/verify-now` → เก็บผล → restore → verify-now ยืนยันกลับ CONFIRMED/INTACT ก่อนทำอันถัดไป

## สรุปผล (1 แถว/สถานการณ์)

ย่อ root: baseline (ที่ anchor ไว้) = `0x96cf68c4…` · ช่อง proof = (log ที่ถูกแตะ / log#1 ที่ไม่ถูกแตะ)

| # | ทำอะไร | dbRoot | chainRoot | computedRoot | proof (แก้/ไม่แตะ) | diff verdict + change | batch หลัง verify | alert |
|---|---|---|---|---|---|---|---|---|
| **A** | แก้ `message` log#3 (ไม่แตะ raw_hash) | `0x96cf68c4…` | `0x96cf68c4…` | `0x96cf68c4…` (**=**) | `true` / `true` | **TAMPERED** · `CONTENT_MODIFIED` field=`message` (before→after) | **TAMPERED** | INTEGRITY_TAMPERED · CRITICAL · OPEN |
| **B** | แก้ `message` log#3 + คำนวณ `raw_hash` ใหม่ให้ตรง | `0x96cf68c4…` | `0x96cf68c4…` | `0x8d8d7db3…` (**≠**) | `false` / `false` | **TAMPERED** · `CONTENT_MODIFIED` fields=`message`,`rawHash` | **TAMPERED** | INTEGRITY_TAMPERED · CRITICAL · OPEN |
| **C** | แก้ `sourceIp` log#5 (ไม่แตะ raw_hash) | `0x96cf68c4…` | `0x96cf68c4…` | `0x96cf68c4…` (**=**) | `true` / `true` | **TAMPERED** · `CONTENT_MODIFIED` field=`sourceIp` (203.0.113.14→8.8.8.8) | **TAMPERED** | INTEGRITY_TAMPERED · CRITICAL · OPEN |
| **D** | ลบ log#4 (logs + mapping) | `0x96cf68c4…` | `0x96cf68c4…` | `0x1f578171…` (**≠**) | `404` / `false` | **TAMPERED** · `DELETED` reason=`ROW_MISSING` pos 3 | **TAMPERED** | INTEGRITY_TAMPERED · CRITICAL · OPEN |
| **E** | เพิ่ม log ปลอม + map เข้า batch | `0x96cf68c4…` | `0x96cf68c4…` | `0xfaeaa2ba…` (**≠**) | `false` / `false` | **TAMPERED** · `UNMAPPED_OR_INSERTED` pos 8 | **TAMPERED** | INTEGRITY_TAMPERED · CRITICAL · OPEN |

ทุกสถานการณ์ restore แล้ว verify-now → batch กลับ **CONFIRMED** + diff **INTACT** + alert เดิมถูกปิดเป็น **RESOLVED** อัตโนมัติ

## แต่ละสถานการณ์ถูกจับด้วยกลไกไหน

มี 4 กลไกซ้อนกัน จับคนละมุม:

1. **Merkle proof / root เทียบเชน** (`computedRoot` vs `chainRoot`, `proof.verify`) — leaf = `sha256(raw_hash)` · root ที่ anchor ไว้บนเชน **แก้ไม่ได้**
2. **raw_hash เทียบเนื้อแถว** (`isRawHashIntact`: recompute hash จากเนื้อ log ปัจจุบันเทียบกับ `raw_hash` ที่เก็บไว้)
3. **snapshot ตอน seal** (`batch_log_snapshot` เก็บ canonical + raw_hash ของทุกตำแหน่ง · ตารางเขียนทับ/ลบไม่ได้) → `/batches/:id/diff` ชี้ตำแหน่ง/field/before→after
4. **สถานะ batch + alert** จาก `verify-now` (`reanchorUnverified` + `verifyAllBatches`)

| # | root/proof จับได้? | raw_hash จับได้? | snapshot diff จับได้? | alert? |
|---|---|---|---|---|
| A (message, raw_hash เดิม) | **ไม่** (root ไม่เปลี่ยน · proof ยัง `true`) | **ใช่** | ใช่ (`CONTENT_MODIFIED/message`) | ใช่ |
| B (message + raw_hash ใหม่) | **ใช่** (`computedRoot`≠`chainRoot` · proof `false`) | ไม่ (เนื้อกับ hash ตรงกันเอง) | ใช่ (`message`,`rawHash`) | ใช่ |
| C (sourceIp, raw_hash เดิม) | **ไม่** (root ไม่เปลี่ยน · proof ยัง `true`) | **ใช่** (sourceIp อยู่ใน canonical hash v2) | ใช่ (`CONTENT_MODIFIED/sourceIp`) | ใช่ |
| D (ลบแถว) | **ใช่** (leaf หาย · root เปลี่ยน · proof `404`) | – | ใช่ (`DELETED/ROW_MISSING`) | ใช่ |
| E (แทรก log ปลอม) | **ใช่** (leaf เกิน · root เปลี่ยน) | – | ใช่ (`UNMAPPED_OR_INSERTED`) | ใช่ |

### ข้อสังเกตสำคัญ (จุดที่กลไกเดียวจับไม่ได้)

- **A และ C แก้แล้ว Merkle root / on-chain anchor ไม่เปลี่ยนเลย** — `computedRoot = chainRoot = dbRoot` และ `proof.verify` ยังเป็น `true` ทั้ง log ที่ถูกแก้และ log อื่น เพราะ leaf มาจาก `raw_hash` ซึ่งผู้แก้ไม่ได้แตะ → **ถ้าตรวจแค่ Merkle proof เทียบเชนอย่างเดียว จะไม่พบ A/C**
  - สิ่งที่ anchor บนเชนพิสูจน์ได้คือ "ชุดของ `raw_hash` ไม่ถูกแก้" **ไม่ใช่** "เนื้อ log แต่ละแถวยังตรงกับ `raw_hash` ของมัน" — อย่างหลังพิสูจน์ด้วยการที่ระบบเก็บเนื้อ + `raw_hash` ไว้แล้ว recompute (กลไก 2) และ snapshot (กลไก 3) ซึ่งอยู่ฝั่ง DB
  - สรุป: A/C ถูกจับได้จริง (TAMPERED + alert + diff) แต่ **ไม่ได้ถูกจับด้วย blockchain** — ถูกจับด้วย raw_hash check + snapshot ฝั่ง server
- **B พิสูจน์ว่าผู้โจมตีที่รู้สูตร raw_hash ก็ยังหนีไม่พ้น** — คำนวณ `raw_hash` ใหม่ให้ตรงเนื้อ (ผ่านกลไก 2) แต่ leaf เปลี่ยน → `computedRoot`≠ root ที่ anchor ไว้บนเชน (กลไก 1) → จับได้ เพราะ root บนเชนแก้ไม่ได้
- **ไม่มีสถานการณ์ไหนที่ระบบจับไม่ได้ทั้งหมด** — ทุกเคสขึ้น batch=TAMPERED + INTEGRITY_TAMPERED (CRITICAL) และ `/diff` ชี้ตำแหน่ง/ชนิดได้ถูกต้อง

## ยืนยันสถานะหลังจบ (restore)

- batch `27941835-…`: **CONFIRMED** · `/diff` = **INTACT** · `proof` log#1/#3 = `verify:true`
- trigger: `trg_logs_no_update` = `O` (enabled) · `trg_logs_no_delete` = `O` (enabled)
- ทุก `DISABLE TRIGGER` มี `ENABLE` คืนใน `finally` · alert ที่เกิดระหว่างทดลองถูกปิดเป็น RESOLVED หมด

## หมายเหตุ

- `rule_id` ของ INTEGRITY_TAMPERED เป็น `null` — alert นี้มาจาก integrity verify ไม่ใช่ rule engine ฝั่ง detection
- diff ระบุ `snapshotTrusted=true`, `trustBasis="chain"` ทุกเคส (snapshot ยัง trust ได้เพราะ root ของ snapshot ตรงกับ root บนเชน) — การทดลองนี้ไม่ได้แตะ snapshot เอง (ต่างจากเคส "แก้ snapshot" ใน `test/tamper-diff.integration.spec.ts` ที่ทำให้ `snapshotTrusted=false`)
