
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
  private readonly logger = new Logger(PiiMaskingService.name)

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

  mask(message: string): { masked: string; hadPii: boolean } {
    let masked = message;
    let hadPii = false;

    for (const { name, regex, replacement } of this.rules) {
      const before = masked;
      masked = masked.replace(regex, replacement);
      if (masked !== before) {
        hadPii = true;
        this.logger.debug(`PII masked: ${name}`);
      }
    }

    return { masked, hadPii };
  }
}