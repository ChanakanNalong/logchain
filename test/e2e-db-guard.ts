/**
 * globalSetup ของ test/jest-e2e.json — กันไม่ให้ integration/e2e ยิง DB ผิดตัว
 *
 * เทสชุดนี้ boot AppModule จริงแล้วเขียน DB ตรง ๆ: seal log ค้าง, verify batch เดิม
 * ทุกใบแล้ว UPDATE สถานะคืน, DISABLE TRIGGER แล้วลบ log ของเทส (ดู integrity /
 * report-cases spec) — ถ้าเผลอชี้ไปที่ stack ที่มีข้อมูล demo จริง batch ที่ anchor
 * ไว้แล้วจะถูกแตะ จึงบังคับให้คนรันประกาศ DB เป้าหมายเองทุกครั้ง
 *
 * ต้องตั้ง E2E_ALLOW_DB=<host>:<port> ให้ตรงกับ DB ที่เทสจะต่อจริง
 * (DB_HOST/DB_PORT แบบเดียวกับ app.module.ts — default localhost:5433)
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse } from 'dotenv';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

const normalizeHost = (h: string) =>
  LOOPBACK.has(h.trim().toLowerCase()) ? 'localhost' : h.trim().toLowerCase();

/** คืนข้อความ error ถ้าไม่ผ่าน · null = ผ่าน */
export function checkE2eDbTarget(
  env: NodeJS.ProcessEnv,
  dotEnv: Record<string, string> = {},
): string | null {
  // ลำดับเดียวกับ ConfigModule: process.env ชนะ .env
  const host = env.DB_HOST || dotEnv.DB_HOST || 'localhost';
  const port = env.DB_PORT || dotEnv.DB_PORT || '5433';
  const target = `${host}:${port}`;
  const allow = env.E2E_ALLOW_DB?.trim();

  const howTo =
    `  เทสจะต่อ DB ที่ ${target} (database logchain) และเขียนข้อมูลลงไปจริง\n` +
    `  ถ้าตั้งใจให้ต่อตัวนี้: E2E_ALLOW_DB=${target} npm run test:e2e\n` +
    `  เครื่อง dev ควรรันกับ environment hh แยก (README หัวข้อ "รัน integration / e2e")\n` +
    `  ไม่ใช่ stack หลักที่มี batch demo อยู่`;

  if (!allow) return `✗ ไม่ได้ตั้ง E2E_ALLOW_DB\n${howTo}`;

  const sep = allow.lastIndexOf(':');
  const allowHost = sep > 0 ? allow.slice(0, sep) : '';
  const allowPort = sep > 0 ? allow.slice(sep + 1) : '';
  if (normalizeHost(allowHost) !== normalizeHost(host) || allowPort !== port) {
    return `✗ E2E_ALLOW_DB=${allow} ไม่ตรงกับ DB ที่จะต่อ (${target})\n${howTo}`;
  }
  return null;
}

export default function e2eDbGuard(): void {
  const envPath = join(process.cwd(), '.env');
  const dotEnv = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
  const err = checkE2eDbTarget(process.env, dotEnv);
  if (err) throw new Error(`\n[e2e-db-guard]\n${err}\n`);
  console.log(
    `[e2e-db-guard] OK — DB ${process.env.E2E_ALLOW_DB} (E2E_ALLOW_DB)`,
  );
}
