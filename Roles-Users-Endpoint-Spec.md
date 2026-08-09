# Roles & Users Management — Endpoint Spec

**สำหรับ:** Person B (Kan) — backend · consume โดย Person C (หน้า Settings)
**Branch:** `feature/cylis-integration-next`
**เป้าหมาย:** endpoint จัดการ user/role จริง (assign/remove role, enable/disable user) แทน mock roles ในหน้า Settings — พร้อม security model ที่ตอบกรรมการได้

> โปรเจกต์นี้ชู security หน้า "จัดการสิทธิ์" คือจุดที่กรรมการเจาะแน่ ทุก endpoint ที่นี่ต้องคิดเรื่อง privilege escalation + audit ตั้งแต่ออกแบบ

---

## 1. Security model (อ่านก่อน)

1. **admin เท่านั้น** — ทุก endpoint ที่นี่ `@Roles('admin')` ไม่มีข้อยกเว้น
2. **Source of truth = Keycloak** ไม่ใช่ app DB — user/role อยู่ที่ Keycloak backend proxy ผ่าน Keycloak Admin REST API **frontend ห้ามคุย Keycloak admin ตรง ๆ เด็ดขาด**
3. **audit ทุก mutation** — assign/remove role, enable/disable ต้องเขียนลง `audit_access` (ใคร ทำอะไร กับใคร ผลเป็นไง)
4. **guard 3 ชั้นกัน escalation**: role allowlist · last-admin protection · self-lockout protection

---

## 2. Infra prerequisite (ต้องทำก่อน endpoint ใช้ได้ — B)

- สร้าง/ยืนยัน **confidential client** (เช่น `logchain-admin-svc`) เปิด service account grant client roles ของ `realm-management`:
  - `view-users`, `view-realm` (สำหรับ list)
  - `manage-users` (สำหรับ assign role / enable-disable)
  - **อย่าให้** `manage-realm` / `realm-admin` (กว้างเกิน เปิดช่อง escalation)
- backend ขอ admin token ผ่าน `client_credentials` grant → cache จน exp → refresh
- **client secret เก็บใน Vault** ไม่ใช่ `.env` (migration เดียวกับ blockchain private key)

---

## 3. Endpoints

### `GET /api/v1/admin/users` — list (admin)
คืน user + realm roles + สถานะ enabled
```jsonc
[ { "id":"...", "username":"admin-user", "email":"...", "firstName":"Admin",
    "lastName":"User", "enabled":true, "roles":["admin","auditor"] } ]
```
- `roles` filter เหลือแค่ 5 app roles — ตัด `default-roles-logchain` / `offline_access` / `uma_authorization` ทิ้ง

### `GET /api/v1/admin/roles` — assignable roles (admin)
คืน **allowlist** ตายตัว ไม่ใช่ raw list จาก Keycloak:
```json
["admin","operator","ingestor","analyst","auditor"]
```

### `POST /api/v1/admin/users/:id/roles` — assign (admin)
Body `{ "role": "auditor" }`
- **guard**: `role` ต้องอยู่ใน allowlist ไม่งั้น 400 (กันการยัด management role เข้าไป)
- audit action `ROLE_ASSIGN`

### `DELETE /api/v1/admin/users/:id/roles/:role` — remove (admin)
- **guard last-admin**: ถ้า `role==='admin'` นับ user ที่มี admin — ถ้าลบแล้วเหลือ 0 admin → **409** (กันระบบไม่มี admin เลย)
- **guard self**: ถ้า `:id === caller.sub` และ `role==='admin'` → **403** (กัน admin ถอด admin ตัวเอง = ล็อกตัวเองออก)
- audit action `ROLE_REVOKE`

### `PATCH /api/v1/admin/users/:id` — enable/disable (admin)
Body `{ "enabled": false }`
- **guard self**: `:id === caller.sub` → **403** (ห้าม disable บัญชีตัวเอง)
- **guard last-admin**: ถ้า disable user ที่เป็น admin คนสุดท้ายที่ enabled อยู่ → **409**
- audit action `USER_ENABLE` / `USER_DISABLE`

---

## 4. Audit (บังคับทุก mutation)

เขียน `audit_access` row ทุกครั้ง (มี table + entity อยู่แล้ว):

| column | ค่า |
|---|---|
| user_id | `caller.sub` (จาก JWT ไม่ใช่จาก body) |
| username | `caller.preferred_username` |
| action | `ROLE_ASSIGN` / `ROLE_REVOKE` / `USER_DISABLE` / `USER_ENABLE` |
| resource | `user:<id> role:<role>` |
| method / status_code | ตาม HTTP |
| ip_address | จาก request |

> ถ้า `AuditInterceptor` ครอบ route พวกนี้อยู่แล้ว เช็คว่า resource/action ละเอียดพอมั้ย — การเปลี่ยน privilege ต้อง audit ระบุ "ใครแก้ role ใคร" ไม่ใช่แค่ "มีคนเรียก endpoint"

---

## 5. Escalation / abuse guards (สรุปให้ตอบกรรมการ)

| ช่องโจมตี | guard |
|---|---|
| ยัด management role ให้ตัวเอง → กลายเป็น realm-admin | **role allowlist** — รับแค่ 5 app roles |
| ลบ admin หมด → ระบบไม่มีใครจัดการได้ | **last-admin guard** (409) |
| admin เผลอ disable/ถอด admin ตัวเอง = lockout | **self guards** (403) |
| frontend ปลอม actor | backend อ่าน identity จาก **JWT sub** เท่านั้น ไม่เชื่อ body |

---

## 6. Validation

- DTO ด้วย class-validator: `role` `@IsIn(allowlist)`, `enabled` `@IsBoolean()`, `:id` validate เป็น UUID
- ทุก mutation ตอบ error ที่ frontend เอาไปโชว์ได้ชัด (409 last-admin, 403 self-lockout)

---

## 7. Acceptance / tests

- admin list users → 200, roles filter เหลือ 5 app roles
- analyst/operator/auditor ยิง endpoint ไหนก็ได้ → **403**
- assign `auditor` ให้ user → 200 + Keycloak สะท้อนจริง + audit row เขียน
- ลบ admin คนสุดท้าย → **409**, ระบบยังมี admin
- disable ตัวเอง → **403**
- assign role นอก allowlist (เช่น `manage-realm`) → **400**
- unit test guard: last-admin count, self-check, allowlist (mock Keycloak client — อย่ายิง Keycloak จริงใน test)

---

## 8. Defense narrative

Map เข้ามาตรฐานได้ตรง:
- **ISO 27001 A.9** — access control, least privilege, formal user provisioning
- **Separation of duties** — admin เท่านั้นที่จัดการสิทธิ์ แยกจาก analyst/operator
- **A.12.4** — audit logging ทุกการเปลี่ยน privilege
- **PDPA accountability** — พิสูจน์ได้ว่าใครให้สิทธิ์ใครเข้าถึงข้อมูลเมื่อไหร่

ตอบคำถาม "จัดการสิทธิ์ยังไง แล้วพิสูจน์ได้ไหมว่าใครทำอะไร" ได้ครบ

---

## 9. Frontend contract (สำหรับ C)

หน้า Settings:
- ตาราง user: username / email / toggle enabled / role chips (เพิ่ม-ลบได้)
- dropdown role จาก `GET /admin/roles`
- **confirm dialog** ก่อน action ที่อันตราย (ลบ role, disable user)
- โชว์ error ให้ชัด: 409 = "ต้องเหลือ admin อย่างน้อย 1 คน", 403 = "แก้สิทธิ์/ปิดบัญชีตัวเองไม่ได้"
- หน้านี้ admin เท่านั้นที่เข้าได้ (คนอื่นไม่ต้องเห็นเมนู)

---

## 10. ลำดับ

1. **B** — สร้าง Keycloak service-account client + เก็บ secret ใน Vault
2. **B** — `KeycloakAdminService` (client_credentials + cache token) + `AdminController` ตาม endpoint ข้างบน + guards + audit
3. **B** — unit test guards
4. **C** — ต่อหน้า Settings ตาม contract §9 (Dashboard เป็น pattern อ้างอิง)

> ⚠️ ผูกกับงาน Vault — ทำ Keycloak service account + Vault ทีเดียวกับตอนย้าย blockchain private key เข้า Vault จะได้ไม่ setup Vault สองรอบ
