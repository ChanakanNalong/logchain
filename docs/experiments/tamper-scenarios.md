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

1. **Merkle proof / root เทียบเชน** (`storedHashRoot` + `contentRoot` vs `chainRoot`, `proof.verify`) · root ที่ anchor ไว้บนเชน **แก้ไม่ได้**
   - `storedHashRoot`: leaf = `raw_hash` ที่เก็บไว้ → แดงเมื่อคอลัมน์ `raw_hash` ถูกแก้
   - `contentRoot` (เพิ่มใน `feature/content-based-current-root`): leaf = hash **คำนวณใหม่จากเนื้อหาปัจจุบัน** → แดงเมื่อเนื้อ log ถูกแก้ · `proof` ก็ใช้ leaf นี้ → `verify:false` เมื่อเนื้อถูกแก้
2. **raw_hash เทียบเนื้อแถว** (`isRawHashIntact`: recompute hash จากเนื้อ log ปัจจุบันเทียบกับ `raw_hash` ที่เก็บไว้)
3. **snapshot ตอน seal** (`batch_log_snapshot` เก็บ canonical + raw_hash ของทุกตำแหน่ง · ตารางเขียนทับ/ลบไม่ได้) → `/batches/:id/diff` ชี้ตำแหน่ง/field/before→after
4. **สถานะ batch + alert** จาก `verify-now` (`reanchorUnverified` + `verifyAllBatches`)

> **อัปเดต (`feature/content-based-current-root`)**: ตารางเดิมด้านล่างสะท้อนพฤติกรรม **ก่อน** เพิ่ม `contentRoot` — ตอนนั้น root/proof ใช้ `raw_hash` อย่างเดียว จึงไม่จับ A/C · **หลังเพิ่ม `contentRoot` แล้ว A/C ถูกจับด้วย root/proof ด้วย** (`contentRoot` ≠ `chainRoot` · `proof.verify = false` · `integrity = CONTENT_MODIFIED`) โดย `storedHashRoot` ยัง `= chainRoot` (raw_hash เดิม) · ส่วน B ยังแดงทั้ง `storedHashRoot` และ `contentRoot`

| # | root/proof จับได้? (หลังเพิ่ม contentRoot) | raw_hash จับได้? | snapshot diff จับได้? | alert? |
|---|---|---|---|---|
| A (message, raw_hash เดิม) | **ใช่** (`contentRoot`≠`chainRoot` · proof `false` · `storedHashRoot` ยัง `true`) | **ใช่** | ใช่ (`CONTENT_MODIFIED/message`) | ใช่ |
| B (message + raw_hash ใหม่) | **ใช่** (ทั้ง `storedHashRoot` และ `contentRoot` ≠ `chainRoot` · proof `false`) | ไม่ (เนื้อกับ hash ตรงกันเอง) | ใช่ (`message`,`rawHash`) | ใช่ |
| C (sourceIp, raw_hash เดิม) | **ใช่** (`contentRoot`≠`chainRoot` · proof `false` · `storedHashRoot` ยัง `true`) | **ใช่** (sourceIp อยู่ใน canonical hash v2) | ใช่ (`CONTENT_MODIFIED/sourceIp`) | ใช่ |
| D (ลบแถว) | **ใช่** (leaf หาย · root เปลี่ยน · proof `404`) | – | ใช่ (`DELETED/ROW_MISSING`) | ใช่ |
| E (แทรก log ปลอม) | **ใช่** (leaf เกิน · root เปลี่ยน) | – | ใช่ (`UNMAPPED_OR_INSERTED`) | ใช่ |

### ข้อสังเกตสำคัญ

- **ก่อนเพิ่ม `contentRoot`:** A และ C แก้แล้ว Merkle root / proof ไม่เปลี่ยน (`computedRoot = chainRoot` · `proof.verify = true`) เพราะ leaf มาจาก `raw_hash` ซึ่งผู้แก้ไม่ได้แตะ — จับได้แค่ด้วย raw_hash check (กลไก 2) + snapshot (กลไก 3) ฝั่ง DB ไม่ใช่ blockchain
- **หลังเพิ่ม `contentRoot`:** leaf ของ `contentRoot`/proof คำนวณใหม่จากเนื้อหาปัจจุบัน → A/C ที่แก้เนื้อ log ทำให้ `contentRoot` ≠ `chainRoot` และ `proof.verify = false` ทันที ("แก้ข้อมูลแบบไหนก็ตาม root ต้องแดง") · `storedHashRoot` แยกไว้จับการแก้คอลัมน์ `raw_hash` โดยตรง (เคส demo-tamper) — ทุกช่องต้องเขียวข้อมูลจึงสมบูรณ์
- **B พิสูจน์ว่าผู้โจมตีที่รู้สูตร raw_hash ก็ยังหนีไม่พ้น** — คำนวณ `raw_hash` ใหม่ให้ตรงเนื้อ (ผ่านกลไก 2) แต่ leaf เปลี่ยน → `computedRoot`≠ root ที่ anchor ไว้บนเชน (กลไก 1) → จับได้ เพราะ root บนเชนแก้ไม่ได้
- **ไม่มีสถานการณ์ไหนที่ระบบจับไม่ได้ทั้งหมด** — ทุกเคสขึ้น batch=TAMPERED + INTEGRITY_TAMPERED (CRITICAL) และ `/diff` ชี้ตำแหน่ง/ชนิดได้ถูกต้อง

## ยืนยันสถานะหลังจบ (restore)

- batch `27941835-…`: **CONFIRMED** · `/diff` = **INTACT** · `proof` log#1/#3 = `verify:true`
- trigger: `trg_logs_no_update` = `O` (enabled) · `trg_logs_no_delete` = `O` (enabled)
- ทุก `DISABLE TRIGGER` มี `ENABLE` คืนใน `finally` · alert ที่เกิดระหว่างทดลองถูกปิดเป็น RESOLVED หมด

## หมายเหตุ

- `rule_id` ของ INTEGRITY_TAMPERED เป็น `null` — alert นี้มาจาก integrity verify ไม่ใช่ rule engine ฝั่ง detection
- diff ระบุ `snapshotTrusted=true`, `trustBasis="chain"` ทุกเคส (snapshot ยัง trust ได้เพราะ root ของ snapshot ตรงกับ root บนเชน) — การทดลองนี้ไม่ได้แตะ snapshot เอง (ต่างจากเคส "แก้ snapshot" ใน `test/tamper-diff.integration.spec.ts` ที่ทำให้ `snapshotTrusted=false`)
