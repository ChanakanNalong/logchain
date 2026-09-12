import { createHash } from 'crypto';

/**
 * Canonical raw hash ของ log 1 record
 *
 * hash ต้องครอบ "ทุก field ที่เป็นหลักฐาน" ไม่ใช่แค่เนื้อข้อความ
 * ไม่งั้นคนที่เข้าถึง DB ได้สามารถแก้ sourceIp / severity / createdAt
 * แล้ว Merkle root ยังตรงเหมือนเดิม → ระบบตรวจไม่พบ
 *
 * id + createdAt อยู่ใน hash ด้วย เพื่อให้ log คนละตัวที่เนื้อเหมือนกัน
 * ได้ leaf คนละค่า (ไม่งั้น Merkle tree แยก log ไม่ออก และ batch คนละใบ
 * ได้ root ซ้ำกัน)
 *
 * ข้อบังคับ:
 *   - message ต้องผ่าน PiiMaskingService.mask() มาแล้วเท่านั้น (PCI Req 3 — PAN ห้ามเข้า hash)
 *   - ห้ามแก้ลำดับ key / ชื่อ key / ค่า v — เปลี่ยนแล้ว hash ของ log เดิมเปลี่ยน
 *     = batch ที่ anchor ไปแล้ว verify ไม่ผ่านทั้งหมด (ต้องขึ้น version ใหม่แทน)
 */

export const RAW_HASH_VERSION = 2;

export interface RawHashInput {
  id: string;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  /** masked แล้วเท่านั้น */
  message: string;
  classification: string;
  cdeScope: boolean;
  createdAt: Date;
}

/**
 * IPv6 เขียนได้หลายรูปแบบ (2001:0DB8::1 = 2001:db8::1) และ Postgres inet
 * คืนค่าแบบย่อ/ตัวพิมพ์เล็กเสมอ — ถ้า hash ค่าดิบที่ client ส่งมา
 * ตอน verify จะ recompute ไม่ตรงทั้งที่ไม่มีใครแก้อะไร
 * จึง normalize ให้เป็นรูปแบบเดียวกับที่ DB เก็บก่อนทั้ง hash และ insert
 */
export function normalizeIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined || ip === '') return null;
  if (!ip.includes(':')) return ip; // IPv4 — Postgres เก็บตามเดิม
  try {
    // WHATWG URL ย่อ IPv6 ตาม RFC 5952 เหมือน Postgres
    return new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return ip.toLowerCase();
  }
}

export function computeRawHash(input: RawHashInput): string {
  // object literal — JSON.stringify คง key order ตามที่เขียนไว้ (ไม่มี key ที่เป็นตัวเลข)
  const canonical = JSON.stringify({
    v: RAW_HASH_VERSION,
    id: input.id,
    source: input.source,
    sourceIp: normalizeIp(input.sourceIp), // null ต้อง serialize เป็น null เสมอ
    eventType: input.eventType,
    severity: input.severity,
    message: input.message,
    classification: input.classification,
    cdeScope: input.cdeScope,
    createdAt: input.createdAt.toISOString(),
  });

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * hash รุ่นแรก — ครอบแค่ 3 field (source, eventType, message)
 * log ที่ ingest ก่อนแก้ช่องโหว่นี้ถูก seal ด้วยค่านี้ ลบทิ้งไม่ได้ (logs immutable)
 * จึงต้องยอมรับไว้ ไม่งั้น batch เก่าทุกใบจะกลายเป็น TAMPERED ทั้งที่ไม่มีใครแก้
 */
function computeLegacyRawHash(
  input: Pick<RawHashInput, 'source' | 'eventType' | 'message'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: input.source,
        eventType: input.eventType,
        message: input.message,
      }),
    )
    .digest('hex');
}

/**
 * row ยังตรงกับ hash ที่ผูกไว้ตอน insert ไหม
 *
 * false = เนื้อ log ถูกแก้หลัง insert (UPDATE ตรงๆ โดนบล็อกด้วย trigger
 * trg_logs_no_update อยู่แล้ว ดังนั้นถ้าเจอ แปลว่าถูกแก้ระดับ DB จริง)
 *
 * legacy log (hash v1) ครอบแค่ 3 field — แก้ severity/ip ของ log เก่าจับไม่ได้
 * แต่แก้ message จับได้เหมือนเดิม
 */
export function isRawHashIntact(
  log: RawHashInput & { rawHash: string },
): boolean {
  if (log.rawHash === computeRawHash(log)) return true;
  return log.rawHash === computeLegacyRawHash(log);
}
