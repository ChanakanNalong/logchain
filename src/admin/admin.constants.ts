/**
 * Allowlist ของ realm role ที่ endpoint จัดการสิทธิ์ยอมให้ assign/remove ได้
 *
 * เป็น allowlist ตายตัว ไม่ใช่ raw list จาก Keycloak โดยเจตนา — ถ้าคืน/รับ role
 * ตามที่ Keycloak มีจริง admin จะยัด realm-management role (manage-realm,
 * realm-admin) ให้ตัวเองได้ = privilege escalation ออกนอกขอบเขตของแอป
 */
export const APP_ROLES = [
  'admin',
  'operator',
  'ingestor',
  'analyst',
  'auditor',
] as const;

export type AppRole = (typeof APP_ROLES)[number];

export const ADMIN_ROLE = 'admin';

export function isAppRole(role: string): role is AppRole {
  return (APP_ROLES as readonly string[]).includes(role);
}
