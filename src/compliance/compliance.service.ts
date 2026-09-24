// src/compliance/compliance.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch, INTACT_STATUSES } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from '../erasure/entities/erasure-log.entity';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * แถวจาก getRawMany/getRawOne — COUNT(...) ของ Postgres มาเป็น string เสมอ
 * (ไม่ใช่ number) ชื่อ key คือ alias ที่ตั้งไว้ใน SELECT
 */
interface IntegrityRawRow {
  day: string;
  confirmed: string;
  sealed: string;
  tampered: string;
  unverified: string;
  pending: string;
  total: string;
  [status: string]: string;
}
interface RetentionRawRow {
  expired: string;
  due_in_30d: string;
  cde_scoped: string;
  total: string;
}
interface AuditRawRow {
  day: string;
  action: string;
  count: string;
}
@Injectable()
export class ComplianceService {
  constructor(
    @InjectRepository(Batch) private batchesRepo: Repository<Batch>,
    @InjectRepository(Log) private logsRepo: Repository<Log>,
    @InjectRepository(AuditAccess) private auditRepo: Repository<AuditAccess>,
    @InjectRepository(ErasureLog)
    private erasureRepo: Repository<ErasureLog>,
  ) {}

  async getReports(fromInput?: string, toInput?: string) {
    const { from, to } = this.resolveRange(fromInput, toInput);
    const toExclusive = this.addDays(to, 1);

    const [integrity, retention, audit, erasure] = await Promise.all([
      this.getIntegrityByDay(from, toExclusive),
      this.getRetentionSnapshot(),
      this.getAuditByDay(from, toExclusive),
      this.getErasureByDay(from, toExclusive),
    ]);

    return {
      period: { from, to },
      generatedAt: new Date().toISOString(),
      integrity,
      retention,
      erasure,
      audit,
    };
  }

  // ---- date range helpers ----
  private resolveRange(from?: string, to?: string) {
    // "วันนี้" ต้องเป็นวันของไทย ให้ตรงกับที่ query จัดกลุ่มตาม Asia/Bangkok — เดิมใช้วันของ UTC
    // ทำให้ 00:00–07:00 ทุกวัน ค่า default ไม่รวมข้อมูลของวันนี้เลย (เจอตอน smoke test 00:55 น.)
    const resolvedTo = to ?? this.bangkokDay(new Date());
    const resolvedFrom = from ?? this.addDays(resolvedTo, -6); // 7-day inclusive window
    if (resolvedFrom > resolvedTo)
      throw new BadRequestException('`from` must be on or before `to`');
    return { from: resolvedFrom, to: resolvedTo };
  }
  private addDays(isoDate: string, n: number): string {
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /**
   * วันตามปฏิทินไทย ให้ตรงกับ `AT TIME ZONE 'Asia/Bangkok'` ที่ integrity/audit ใช้
   * Asia/Bangkok เป็น UTC+7 ตลอดปี ไม่มี DST จึงเลื่อนด้วย offset คงที่ได้
   */
  private bangkokDay(raw: string | number | Date): string {
    return new Date(new Date(raw).getTime() + BANGKOK_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
  }

  // ---- ① integrity per day ----
  private async getIntegrityByDay(from: string, toExclusive: string) {
    const rows = await this.batchesRepo
      .createQueryBuilder('batch')
      .select(
        `to_char(date_trunc('day', batch.sealed_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD')`,
        'day',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE batch.status='CONFIRMED')`,
        'confirmed',
      )
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='SEALED')`, 'sealed')
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='TAMPERED')`, 'tampered')
      .addSelect(
        `COUNT(*) FILTER (WHERE batch.status='UNVERIFIED')`,
        'unverified',
      )
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='PENDING')`, 'pending')
      // FAILED = anchor พลาด ไม่มี log ผูกจริง — กันออกจากตัวหารให้ตรงกับ stats.service
      // ไม่งั้นแค่ RPC ล่มก็ทำให้ integrityRate ของ Reports ต่ำกว่า Dashboard
      .addSelect(`COUNT(*) FILTER (WHERE batch.status<>'FAILED')`, 'total')
      .where(
        `(batch.sealed_at AT TIME ZONE 'Asia/Bangkok') >= :from::timestamp
              AND (batch.sealed_at AT TIME ZONE 'Asia/Bangkok') < :toExclusive::timestamp`,
        { from, toExclusive },
      )
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<IntegrityRawRow>();

    return rows.map((r) => {
      const total = +r.total;
      // สูตรเดียวกับ stats.service (Dashboard) — intact = CONFIRMED + SEALED
      // alias ของแต่ละสถานะใน SELECT ด้านบนคือชื่อสถานะตัวเล็ก
      const intact = INTACT_STATUSES.reduce(
        (n, st) => n + (+r[st.toLowerCase()] || 0),
        0,
      );
      return {
        day: r.day,
        confirmed: +r.confirmed,
        sealed: +r.sealed,
        tampered: +r.tampered,
        unverified: +r.unverified,
        pending: +r.pending,
        total,
        integrityRate: total ? Math.round((intact / total) * 100) : 0,
      };
    });
  }

  // ---- ② retention snapshot (as of now) ----
  private async getRetentionSnapshot() {
    const row = await this.logsRepo
      .createQueryBuilder('log')
      .select(
        `COUNT(*) FILTER (WHERE log.created_at + (log.retention_days || ' days')::interval < now())`,
        'expired',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE log.created_at + (log.retention_days || ' days')::interval BETWEEN now() AND now() + interval '30 days')`,
        'due_in_30d',
      )
      .addSelect(`COUNT(*) FILTER (WHERE log.cde_scope)`, 'cde_scoped')
      .addSelect('COUNT(*)', 'total')
      .getRawOne<RetentionRawRow>();
    if (!row) return { expired: 0, dueIn30d: 0, cdeScoped: 0, total: 0 };
    return {
      expired: +row.expired,
      dueIn30d: +row.due_in_30d,
      cdeScoped: +row.cde_scoped,
      total: +row.total,
    };
  }

  // ---- ③ erasure per day (ตาราง erasure_log) ----
  // เดิมอ่านจาก erasure-log.json ซึ่งใน container ไม่เคยถูกเขียน (EACCES) และจัดกลุ่มตาม `erasedAt`
  // ขณะที่ ErasureService เขียน `deletedAt` → หน้า Reports แสดง 0 เสมอ
  private async getErasureByDay(from: string, toExclusive: string) {
    const rows = await this.erasureRepo
      .createQueryBuilder('e')
      .where(
        `(e.deleted_at AT TIME ZONE 'Asia/Bangkok') >= :from::timestamp
              AND (e.deleted_at AT TIME ZONE 'Asia/Bangkok') < :toExclusive::timestamp`,
        { from, toExclusive },
      )
      .orderBy('e.deleted_at', 'ASC')
      .getMany();

    // รูปแบบเดียวกับ tombstone ที่ ErasureService คืนให้ client (หน้า Reports / CSV ใช้ field พวกนี้)
    type Tombstone = {
      userId: string;
      requestedBy: string;
      deletedAt: string;
      recordsDeleted: number;
      method: string;
      pseudonym: string | null;
      hash: string;
    };
    const byDay = new Map<string, Tombstone[]>();
    for (const r of rows) {
      const day = this.bangkokDay(r.deletedAt);
      const list = byDay.get(day) ?? byDay.set(day, []).get(day)!;
      list.push({
        userId: r.userId,
        requestedBy: r.requestedBy,
        deletedAt: r.deletedAt.toISOString(),
        recordsDeleted: r.recordsDeleted,
        method: r.method,
        pseudonym: r.pseudonym,
        hash: r.hash,
      });
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, recs]) => ({ day, requests: recs.length, records: recs }));
  }

  // ---- ④ audit per day ----
  private async getAuditByDay(from: string, toExclusive: string) {
    const rows = await this.auditRepo
      .createQueryBuilder('audit')
      .select(
        `to_char(date_trunc('day', audit.accessed_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD')`,
        'day',
      )
      .addSelect('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where(
        `(audit.accessed_at AT TIME ZONE 'Asia/Bangkok') >= :from::timestamp
              AND (audit.accessed_at AT TIME ZONE 'Asia/Bangkok') < :toExclusive::timestamp`,
        { from, toExclusive },
      )
      .groupBy('day')
      .addGroupBy('audit.action')
      .orderBy('day', 'ASC')
      .getRawMany<AuditRawRow>();

    const map = new Map<string, Record<string, number>>();
    for (const r of rows) {
      if (!map.has(r.day)) map.set(r.day, {});
      map.get(r.day)![r.action] = +r.count;
    }
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, byAction]) => ({ day, byAction }));
  }
}
