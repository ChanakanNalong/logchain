# LogChain — บริบทสำหรับ Claude Code

**เริ่มทุก session ด้วยการอ่าน [`docs/plan/next-steps.md`](docs/plan/next-steps.md)**
ไฟล์นั้นมีงานค้างเรียงลำดับ คำสั่งที่ใช้บ่อย ข้อ "ห้ามทำ" ที่ถกจบแล้ว และตารางกับดัก
บันทึกงานเต็มอยู่ใน `docs/worklog/<YYYY-MM-DD>.md`

## ระบบนี้คืออะไร

API gateway (NestJS) รับ log → PII masking → Postgres (append-only) → Kafka → detection (Python:
rule engine + DeepLog) → alert · integrity ใช้ Merkle root ต่อ batch แล้ว anchor ขึ้น Polygon Amoy
· secret อยู่ใน Vault (AppRole) · auth ผ่าน Keycloak (OIDC) · ยกทั้งระบบด้วย `./scripts/bootstrap.sh`

## กฎที่ต้องรู้ก่อนแก้โค้ด

- **เปลี่ยน schema = เพิ่ม migration** ใน `src/database/migrations/` แล้วใส่ใน array `migrations`
  ของ `app.module.ts` (backend รันเองตอน boot) · **ห้ามแก้ `infra/postgres/init/`** เพื่อเปลี่ยน schema
  ไฟล์พวกนั้นรันเฉพาะตอน volume ว่าง DB ที่มีอยู่แล้วจะไม่ได้รับ
- **ตาราง `logs` เป็น append-only** — trigger `trg_logs_no_update` บล็อก UPDATE/DELETE
- **ก่อน commit ให้รัน `npm run lint:ci`** (มีเพดาน warning 668) ไม่ใช่ `npm run lint`
  ชุดที่ CI รันจริง: `lint:ci` + `npm test` + `npm run build` + `npx jest --config test/jest-e2e.json`
- **e2e ยิง DB จริงและทิ้ง batch UNVERIFIED ไว้** (`tx_hash` ขึ้นต้น `0xaaaa…`) ลบทุกครั้งหลังรัน
- **`docker compose` ต้องมี `HOST_UID=$(id -u) HOST_GID=$(id -g)` เสมอ** ไม่งั้นไฟล์ของ Vault เป็นของ root
- **ห้าม `docker compose down -v`** ถ้ายังอยากได้ข้อมูล demo เดิม
- เจ้าของเครื่องชอบรัน git เอง — **พิมพ์คำสั่ง git ให้ผู้ใช้รัน อย่ารันเอง**

## โครงสร้างที่ต้องรู้

| ที่อยู่ | คืออะไร |
|---|---|
| `src/` | backend NestJS (logs · alerts · integrity · blockchain · kafka · compliance · stats) |
| `detection/` | Python: FastAPI (`app/main.py`) + Kafka consumer (`app/consumer.py`) + rules |
| `cylis-dashboard/` | Next.js dashboard (service ใน compose ชื่อ `cylis-dashboard`) |
| `infra/` | postgres init · keycloak realm template · vault · kafka certs · prometheus/grafana |
| `scripts/` | `bootstrap.sh` · demo ต่าง ๆ · `vault-unlock.sh` |
| `docs/plan/` · `docs/worklog/` · `docs/runbooks/` | แผนปัจจุบัน · บันทึกรายวัน · runbook |

รายละเอียดการติดตั้ง/แก้ปัญหาอยู่ใน `README.md` (หัวข้อ Troubleshooting และ Vault user lockout)
