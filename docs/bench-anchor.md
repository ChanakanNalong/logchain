# Bench: anchor ทีละ log vs 1 Merkle root ต่อ batch

สรุป: ค่า tx ไม่ขึ้นกับจำนวน log ใน batch (contract เก็บ 32 byte ต่อ batch) → **ประหยัด = จำนวน log ต่อ batch**
100 log ต่อ batch = จ่าย 1 tx แทน 100 tx = ถูกลง 100 เท่า

## 1. Bench บน Hardhat (simulated network)

`~/Documents/logchain-contracts/scripts/bench-anchor.ts` (ผลดิบ: `bench-anchor.json` ใน repo นั้น)

- contract: `LogIntegrity.sol` ตัวจริง · network: Hardhat EDR simulated
- leaf/root แบบเดียวกับ `src/integrity/service/merkle.service.ts`: raw_hash = sha256 ของ JSON canonical (log-hash v2)
  · leaf = sha256(utf8 ของ raw_hash hex) · `sortPairs` · merkletreejs 0.6.0 (รุ่นเดียวกับ backend) · batchId = keccak256(UUID)

```bash
cd ~/Documents/logchain-contracts && npx hardhat run scripts/bench-anchor.ts      # N=100 ค่าเริ่มต้น
```

| แบบ (100 log) | tx | gas รวม | gas ต่อ log | เวลา (simulated) |
|---|---:|---:|---:|---:|
| (ก) `storeRoot` 100 ครั้ง · 1 log = 1 tx (batchId ต่างกัน) | 100 | 7,120,468 | 71,204.7 | 75 ms |
| (ข) Merkle root เดียว · 100 log = 1 tx | 1 | 71,209 | 712.1 | 1 ms |
| **(ก) ÷ (ข)** | **100×** | **100×** | | |

gas ต่อ batch ตามขนาด batch — คงที่:

| log ต่อ batch | gas ต่อ batch | gas ต่อ log |
|---:|---:|---:|
| 1 | 71,209 | 71,209.0 |
| 10 | 71,209 | 7,120.9 |
| 50 | 71,209 | 1,424.2 |
| 100 | 71,209 | 712.1 |
| 250 | 71,209 | 284.8 |
| 500 | 71,209 | 142.4 |

- เวลาใน simulated network ไม่มีความหมายเชิงสัมบูรณ์ (mine ทันที) — บน Amoy tx หนึ่งรอ confirm ~6.5 วิ
  และ backend ส่ง tx ทีละตัว (คิว nonce) → (ก) 100 tx ≈ 11 นาที · (ข) ≈ 6.5 วิ
- gas บน Hardhat (71,209) ต่ำกว่าบน Amoy (78,132–78,156) ราว 7k — **UNKNOWN** ว่าเพราะอะไร
  (น่าจะเป็น artifact/compiler setting ของ contract ที่ deploy บน Amoy ต่างจากที่ compile ใน repo) · สัดส่วน 100× ไม่เปลี่ยน
  เพราะ gas ต่อ tx คงที่ทั้งสองที่ · พิสูจน์ได้ด้วยการ deploy artifact `ignition/deployments/chain-80002` ลง Hardhat แล้ววัดซ้ำ

## 2. ค่าจริงบน Polygon Amoy (52 batch ของ stack หลัก)

จาก `node scripts/backfill-batch-gas.mjs` (dry-run · อ่าน receipt ตาม `tx_hash` · ไม่เขียน DB · 2026-10-15)

| | ค่า |
|---|---|
| batch ที่มี tx_hash | 52 |
| receipt เจอ (status 1, to = contract) | 47 |
| gas ต่อ tx | min 78,132 · max 78,156 · เฉลี่ย 78,153 (37 จาก 47 = **78,156** พอดี) |
| gas price ที่จ่ายจริง | 25 – 500 gwei (500 = ช่วงก่อนตั้งเพดานทิป `BLOCKCHAIN_MAX_PRIORITY_FEE_GWEI=50`) |
| ค่า tx เฉลี่ย | 0.00730 POL (รวม 47 tx = 0.343 POL) |
| tx_hash หา receipt ไม่เจอ | 5 ใบ (`839e295c` `38d4b0ce` `6fa81a06` `a4516a5d` `d720bdb5`, seal 12–18 ก.ย.) — **root ของทั้ง 5 อยู่บน contract ตรงกับ DB** (เช็คด้วย `getRoot`) แต่ tx_hash ที่บันทึกไว้ไม่ใช่ tx ที่ลงจริง (น่าจะถูกแทนที่ / re-anchor ภายหลังโดยไม่ได้อัปเดต hash) → backfill ข้าม gas ของ 5 ใบนี้ยังเป็น NULL |

ค่าใช้จ่ายต่อ tx = 78,156 × gas price:

| gas price | POL ต่อ batch |
|---|---:|
| 25 gwei (ขั้นต่ำของ Amoy) | 0.00195 |
| 50 gwei (เพดานทิปปัจจุบัน) | 0.00391 |
| 500 gwei (RPC แนะนำช่วงพีค ก่อนมีเพดาน) | 0.03908 |

## 3. ค่าใช้จ่ายตามรอบ seal (300 log/ชม. สม่ำเสมอ · 78,156 gas/tx)

แต่ละรอบปิด log ที่ค้างทั้งหมดทีละ `SEAL_BATCH_SIZE` (ค่าเริ่มต้น 100) — 1 batch = 1 tx · รอบที่ไม่มี log ไม่เสียอะไร

| `SEAL_CRON` | log ต่อรอบ | `SEAL_BATCH_SIZE` | batch ต่อรอบ | tx/วัน | gas ต่อ log | POL/วัน @25 gwei | POL/วัน @50 gwei | wallet 0.0897 POL อยู่ได้ (@50) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 นาที | 5 | 100 | 1 | 1,440 | 15,631 | 2.81 | 5.63 | 23 นาที |
| 5 นาที | 25 | 100 | 1 | 288 | 3,126 | 0.563 | 1.13 | 1.9 ชม. |
| 30 นาที | 150 | 100 | 2 | 96 | 1,042 | 0.188 | 0.375 | 5.7 ชม. |
| 30 นาที | 150 | 500 | 1 | 48 | 521 | 0.094 | 0.188 | 11.5 ชม. |
| 60 นาที | 300 | 100 | 3 | 72 | 782 | 0.141 | 0.281 | 7.7 ชม. |
| 60 นาที | 300 | 500 | 1 | 24 | 261 | 0.047 | 0.094 | 23 ชม. |

- **ที่ประหยัดได้คือจำนวน log ต่อ batch** ไม่ใช่ตัว cron — รอบยาวขึ้นช่วยเพราะทำให้ batch ใหญ่ขึ้น ถ้า batch size ตันที่ 100
  รอบ 30/60 นาทีจะแตกเป็นหลาย batch (= หลาย tx) ต้องขยาย `SEAL_BATCH_SIZE` ตามด้วย
- ข้อแลก: รอบยาว = log รอนานขึ้นก่อนถูกตรึงบน chain (สูงสุด ≈ ความยาวรอบ + เวลา confirm) · proof / tamper detection
  แบบ local ใช้ได้ทันทีหลัง seal อยู่แล้ว ที่รอคือการยืนยันกับ chain
- ตัวเลขข้างบนเป็นกรณีสม่ำเสมอ (ทุกรอบมี log) — traffic เป็นช่วง ๆ จะใช้ tx น้อยกว่านี้
- ค่า gas ต่อ batch จริงเก็บใน `batches.gas_used` / `effective_gas_price` แล้ว (migration `1790899200000`) — batch เก่าเติมด้วย
  `scripts/backfill-batch-gas.mjs --apply`
