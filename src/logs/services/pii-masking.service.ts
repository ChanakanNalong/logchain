import { Injectable, Logger } from '@nestjs/common';

/**
 * PiiMaskingService — PDPA + PCI-DSS Req 3
 *
 * กฎสำคัญ: mask() ต้องถูกเรียกก่อน hash() เสมอ
 * เพราะ PCI Req 3 ห้าม PAN (card number) ผ่านระบบในรูปแบบ plaintext
 *
 * ลำดับที่ถูกต้องใน LogsService:
 *   1. mask(message)     ← ลบ PII ออกก่อน
 *   2. sha256(masked)    ← hash ของข้อความที่สะอาดแล้ว
 *   3. บันทึก masked + hash ลง DB
 */
@Injectable()
export class PiiMaskingService {
  private readonly logger = new Logger(PiiMaskingService.name);

  // rules — แต่ละ rule มี regex สำหรับจับ PII และ replacement สำหรับแทนที่
  private readonly rules = [
    {
      name: 'email',
      regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      replacement: '[EMAIL]',
    },
    {
      name: 'thai_national_id',
      // รูปแบบ Thai ID: 1-2345-67890-12-3 หรือ 1234567890123
      regex: /\b\d{1}-?\d{4}-?\d{5}-?\d{2}-?\d{1}\b/g,
      replacement: '[THAI_ID]',
    },
    {
      name: 'phone_th',
      // เบอร์มือถือไทย: 08x-xxx-xxxx
      regex: /\b0[689]\d[\s-]?\d{3}[\s-]?\d{4}\b/g,
      replacement: '[PHONE]',
    },
    {
      name: 'credit_card',
      // PAN (Primary Account Number) — PCI Req 3 critical
      // จับ "16 หลักแบ่งเป็นกลุ่มละ 4" ก่อน แล้วค่อยกรองด้วย UUID + Luhn ใน maskCreditCards
      // (ไม่ใช้ replacement ตรง ๆ — credit_card เดินผ่าน branch พิเศษใน mask())
      regex: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
      replacement: '[PAN]',
    },
    {
      name: 'ipv4_last_octet',
      // mask แค่ octet สุดท้าย: 192.168.1.100 → 192.168.1.xxx
      regex: /\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b/g,
      replacement: '$1.xxx',
    },
  ];

  // UUID (8-4-4-4-12 hex) — ไม่ใช่เลขบัตร แม้ 16 nibble ท้ายจะเป็นตัวเลขล้วน
  // (เช่น batch id ใน URL ...-9420-211004614088 ที่ credit_card regex จับได้)
  private static readonly UUID =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  mask(message: string): { masked: string; hadPii: boolean } {
    let masked = message;
    let hadPii = false;

    for (const { name, regex, replacement } of this.rules) {
      const before = masked;
      masked =
        name === 'credit_card'
          ? this.maskCreditCards(masked, regex)
          : masked.replace(regex, replacement);
      if (masked !== before) {
        hadPii = true;
        this.logger.debug(`PII masked: ${name}`);
      }
    }

    return { masked, hadPii };
  }

  /**
   * mask เฉพาะเลขที่เป็น PAN จริง: ข้ามเลขที่อยู่ในก้อน UUID ทั้งก้อน แล้ว mask
   * เฉพาะเลข 16 หลักที่ผ่าน Luhn — กัน UUID / id ยาว ๆ ในข้อความถูก mask เป็น [PAN] ผิด ๆ
   * (เลขบัตรจริงผ่าน Luhn · ดู false positive 2026-10-16: UUID ใน URL → [PAN] → rule 90001)
   */
  private maskCreditCards(text: string, regex: RegExp): string {
    const uuidSpans: Array<[number, number]> = [];
    for (const m of text.matchAll(PiiMaskingService.UUID)) {
      uuidSpans.push([m.index, m.index + m[0].length]);
    }
    regex.lastIndex = 0;
    return text.replace(regex, (match: string, offset: number) => {
      const end = offset + match.length;
      const inUuid = uuidSpans.some(([s, e]) => offset < e && end > s);
      if (inUuid) return match;
      return isLuhnValid(match.replace(/[\s-]/g, '')) ? '[PAN]' : match;
    });
  }
}

/** Luhn (mod 10) — เลขบัตรจริงต้องผ่าน · ใช้กรองเลข 16 หลักที่บังเอิญหน้าตาเหมือนบัตร */
function isLuhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
