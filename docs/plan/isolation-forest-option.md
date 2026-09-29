# ตัวเลือก: จำแนก Batch ด้วย Isolation Forest

> **▶ เจ้าของตัดสินใจจะทำ (2026-09-29):** เพิ่ม Isolation Forest กลับเข้าโค้ด แล้วดันกลไกตรวจจับกลับเป็น **3 ระดับ** (Rule + DeepLog + Isolation Forest) เหมือนที่เล่มเดิมเคยเขียน
> - เมื่อทำเสร็จ ต้อง**ย้อนการแก้ 09-29 ในเล่ม**: ใส่ 3.9.6 / 4.6.6 กลับ · แถวตารางเทคโนโลยี · DR-09 / DR-10 · เปลี่ยน "สองระดับ" → "สามระดับ" ทุกจุด · กรณีทดสอบ 58 → 60 · ตรวจจับ 8 → 10 (ต้นฉบับก่อนลบอยู่ใน `…ก่อนแก้DeepLog.docx`)
> - ทำตามขอบเขต/ตารางเวลาด้านล่าง (~4–6 วันทำงาน) · อ่านหัวข้อ "ทำไมยังไม่ทำ" เป็นความเสี่ยงที่ต้องจัดการ ไม่ใช่เหตุผลไม่ทำอีกต่อไป
>
> สถานะเดิม 2026-09-29 (ก่อนตัดสินใจ): ไม่มีในโค้ด · เอาออกจากเล่มแล้ว (worklog 2026-09-29 หัวข้อ 5) · เล่มเดิมบรรยายที่ 3.9.6 · 4.6.6 · ตารางเทคโนโลยี · DR-09 / DR-10

## ความคืบหน้า

- **✅ สเตจ 1 — แกน detection (Python) เสร็จ 2026-09-29** · เทสต์ครบในอิมเมจ (32 ผ่าน · pure feature 12 รันบน host ได้)
  - `detection/app/batch_features.py` — feature 10 ตัวระดับ batch (pure stdlib): `log_count · distinct_source_ips · distinct_sources · distinct_event_types · event_type_entropy · max_event_type_share · frac_auth_failure · frac_high_severity · frac_cde · logs_per_second`
  - `detection/app/batch_model.py` — Isolation Forest wrapper · **graceful: ไม่มีโมเดล → unavailable, is_anomaly=False ไม่ throw** (backend ปิด batch ได้แม้ยังไม่ train) · import sklearn แบบ lazy
  - endpoint `POST /api/v1/detect-batch` (`app/main.py`) + schemas · `train_isoforest.py` (unsupervised, input JSONL ของ batch ปกติ)
  - `requirements.txt` +scikit-learn 1.7.2 +joblib 1.5.2 → `requirements.lock` regenerate (52 pkg) · pip-audit ผ่าน · image build ผ่าน
  - tests: `tests/test_batch_features.py` (12) · `tests/test_batch_model.py` (unavailable path + sklearn path · skip ถ้า host ไม่มี dep)
- **⬜ สเตจ 2 — backend wiring:** migration เพิ่มคอลัมน์ผล/คะแนนใน `batches` · เรียก `/api/v1/detect-batch` ตอนปิด batch ใน `sealBatch()` **โดย detection ล่ม/timeout แล้ว batch ต้องยังปิดได้** (ผลเป็นค่าว่าง) · เทสต์
- **⬜ สเตจ 3 — dashboard:** แสดงผลจำแนกในหน้า Verify / Reports
- **⬜ สเตจ 4 — ข้อมูล + ประเมิน:** ⚠️ **ตัวติดหลัก** — export batch ปกติเป็น JSONL → train · สร้างสถานการณ์ผิดปกติ (port scan · brute force ปริมาณมาก · DoS) วัดผล
- **⬜ สเตจ 5 — เล่ม:** ย้อนการแก้ 09-29 (ดูหัวบนสุด)

## ทำไมยังไม่ทำ (บริบทเดิม ก่อนตัดสินใจ 2026-09-29 — ตอนนี้เป็นความเสี่ยงที่ต้องจัดการ)

- **ไม่มีข้อมูลให้ train / วัดผล** — batch จริง 37 ใบ ส่วนใหญ่มาจากการทดสอบ ไม่มี label ว่าใบไหนผิดปกติ → วัด precision / recall ไม่ได้
- **ซ้ำกับของที่มี** — กฎ 5710 (threshold ตามเวลา) · DeepLog · alert ของ Prometheus จับปริมาณที่พุ่งได้บางส่วนแล้ว
- **batch ไม่เหมาะเป็นหน่วยวิเคราะห์** — ปิดทุกนาทีหรือครบ 100 log ขนาด/ช่วงเวลาไม่เท่ากัน feature แกว่งตาม traffic → แจ้งเตือนผิดบ่อย
- **เสี่ยงช่วงก่อนส่ง** — ต้องแตะ `sealBatch()` ซึ่งเป็นแกน integrity (เพิ่งแก้บั๊ก IM-12)

ประโยชน์ที่อาจได้: เห็นความผิดปกติ "ภาพรวมของช่วงเวลา" ที่กฎทีละ log มองไม่เห็น (สัดส่วนประเภท event พุ่ง · จำนวน IP ต้นทางเพิ่มทันที — สแกน / DoS)

## ถ้าจะทำ — ขอบเขตและเวลา (~4–6 วันทำงาน)

| ส่วน | งาน | วัน |
|---|---|---|
| detection (Python) | เพิ่ม `scikit-learn` ใน `requirements.txt` → `./scripts/detection-lock.sh` (lock + pip-audit) · image ใหญ่ขึ้น · โมดูลคำนวณ feature ของ batch (สัดส่วน event type · severity · จำนวน IP ต้นทางไม่ซ้ำ · อัตรา log ต่อนาที) + endpoint · สร้างข้อมูล train | 1–1.5 |
| backend | migration ใหม่ใน `src/database/migrations/` (+ ใส่ array `migrations` ใน `app.module.ts`): คอลัมน์ผลจำแนก / คะแนนใน `batches` · เรียก detection ตอนปิด batch **โดย detection ล่มแล้ว batch ต้องยังปิดได้** (ผลจำแนกเป็นค่าว่าง) · เทสต์ | 1 |
| dashboard | แสดงผลจำแนกในหน้า Verify / Reports | 0.5 |
| ประเมิน | สร้างสถานการณ์ปกติ / ผิดปกติ (สแกน · brute force ปริมาณมาก) แล้ววัดผล | 1–2 |
| เล่ม | ใส่ 3.9.6 / 4.6.6 กลับ · DR-09 / DR-10 · ตัวเลขประเมิน · ปรับ "สองระดับ" กลับเป็น "สามระดับ" · จำนวนกรณี 58 → 60 | 0.5–1 |

ข้อควรรู้: แม้ทำครบ ตัวเลขประเมินมาจากสถานการณ์จำลองที่สร้างเอง น้ำหนักทางวิชาการน้อยกว่า DeepLog ที่วัดกับชุดข้อมูลมาตรฐาน

## ทางเลือกที่เบากว่า

ใส่เป็น**ข้อเสนอแนะในเล่มหัวข้อ 5.7** เช่น "ตรวจความผิดปกติระดับช่วงเวลาด้วย Isolation Forest เมื่อมีข้อมูล batch จากการใช้งานจริงเพียงพอ" — < 1 ชม. · ถ้าอาจารย์กำหนดให้ต้องมี ค่อยทำตามตารางข้างบน (เผื่อ ≥ 1 สัปดาห์ก่อนส่ง)
