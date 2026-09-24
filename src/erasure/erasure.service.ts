import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from './entities/erasure-log.entity';
import { VaultService } from '../vault/vault.service';
import * as crypto from 'crypto';

const PSEUDONYM_PREFIX = 'anon-';

/** HMAC ไม่ใช่ hash เปล่า — user_id เป็น UUID จาก Keycloak ถ้าไม่มี key ก็ไล่ hash ทุก user แล้วจับคู่กลับได้ */
export function pseudonymize(keyHex: string, userId: string): string {
  return (
    PSEUDONYM_PREFIX +
    crypto
      .createHmac('sha256', Buffer.from(keyHex, 'hex'))
      .update(userId)
      .digest('hex')
  );
}

/**
 * regex (Postgres ARE) ที่จับ userId เฉพาะตอนเป็น segment เต็มของ URL — `/users/<id>/roles`, `?user=<id>`
 * ไม่ใช่ substring ธรรมดา: userId สั้น ๆ อย่าง "1" จะไปแก้ทุก resource ที่มีเลข 1
 */
export function resourcePattern(userId: string): string {
  const esc = (s: string) => s.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  const forms = [...new Set([userId, encodeURIComponent(userId)])].map(esc);
  return `(^|[/=])(?:${forms.join('|')})(?=[/?&#]|$)`;
}

@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly vault: VaultService,
  ) {}

  /**
   * PDPA erasure แบบ pseudonymize (review B10) — แถวใน audit_access ยังอยู่ครบ (PCI 10.5.1 เก็บ ≥ 12 เดือน)
   * แต่ระบุตัวคนไม่ได้: user_id → HMAC · username / ip_address → NULL · userId ใน resource ของแถวอื่น
   * (เช่น admin แก้ role ของ user นี้) → HMAC เดียวกัน · ทั้งหมด + tombstone อยู่ใน transaction เดียว
   * บันทึกหลักฐานไม่ได้ = ไม่แก้อะไรเลย
   *
   * เจ้าของ key (Vault `secret/logchain/erasure`) คำนวณ HMAC ของ userId ที่สงสัยแล้วตามรอยใน audit ได้
   * — ตั้งใจ: การสืบสวนตาม PCI 10 ยังทำได้ แต่คนที่อ่าน DB/backup อย่างเดียวทำไม่ได้
   */
  async eraseUser(userId: string, requestedBy: string): Promise<object> {
    if (userId.startsWith(PSEUDONYM_PREFIX)) {
      throw new BadRequestException(
        `userId ${userId} is already a pseudonym — nothing to erase`,
      );
    }
    const key = this.vault.get().erasure.pseudonymKey;
    if (!key) {
      // ไม่ fallback ไปลบจริง (ขัด PCI) หรือ hash เปล่า (ย้อนกลับได้) — ให้คนแก้ Vault ก่อน
      throw new ServiceUnavailableException(
        'Erasure pseudonym key missing in Vault (secret/logchain/erasure) — re-run vault-init',
      );
    }
    const pseudonym = pseudonymize(key, userId);

    return this.dataSource.transaction(async (m) => {
      // ใช้จำนวนที่แก้ได้จริง ไม่ใช่ find ก่อนแก้ — audit ของ user อาจเพิ่มระหว่างสองคำสั่ง
      const { affected } = await m.update(
        AuditAccess,
        { userId },
        { userId: pseudonym, username: null, ipAddress: null },
      );
      const recordsPseudonymized = affected ?? 0;

      // pg คืน [rows, rowCount] สำหรับ UPDATE · left(256) = ความยาวคอลัมน์ (pseudonym ยาวกว่า UUID
      // URL ที่ยาวอยู่แล้วจะล้นแล้วทั้ง transaction rollback)
      const [, referencesPseudonymized] = await m.query<[unknown, number]>(
        `UPDATE audit_access
            SET resource = left(regexp_replace(resource, $1, '\\1' || $2, 'g'), 256)
          WHERE resource ~ $1`,
        [resourcePattern(userId), pseudonym],
      );

      // ดูแถวของ user เองเท่านั้น — resource ของแถวอื่นมี id ที่ไม่เคยเป็น user จริงได้
      // (เช่น URL ของคำขอลบที่เคยตอบ 404) · โยน = rollback การแก้ resource ด้วย
      if (recordsPseudonymized === 0) {
        throw new NotFoundException(`No records found for userId: ${userId}`);
      }

      // Tombstone = proof of erasure (PDPA compliance evidence)
      const deletedAt = new Date();
      const tombstone = {
        userId,
        requestedBy,
        deletedAt: deletedAt.toISOString(),
        recordsDeleted: recordsPseudonymized,
        method: 'PSEUDONYMIZE' as const,
        pseudonym,
        hash: crypto
          .createHash('sha256')
          .update(userId + deletedAt.toISOString())
          .digest('hex'),
      };
      await m.insert(ErasureLog, { ...tombstone, deletedAt });
      this.logger.log(
        `Pseudonymized ${recordsPseudonymized} audit records (+${referencesPseudonymized} references) → ${pseudonym} (tombstone recorded)`,
      );

      return {
        message: 'User data erased successfully (audit trail pseudonymized)',
        tombstone,
        referencesPseudonymized,
      };
    });
  }
}
