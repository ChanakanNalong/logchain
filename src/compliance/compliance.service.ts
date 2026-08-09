// src/compliance/compliance.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

@Injectable()
export class ComplianceService {
  private readonly erasureLogPath = path.join(process.cwd(), 'erasure-log.json');

  constructor(
    @InjectRepository(Batch) private batchesRepo: Repository<Batch>,
    @InjectRepository(Log) private logsRepo: Repository<Log>,
    @InjectRepository(AuditAccess) private auditRepo: Repository<AuditAccess>,
  ) {}

  async getReports(fromInput?: string, toInput?: string) {
    const { from, to } = this.resolveRange(fromInput, toInput);
    const toExclusive = this.addDays(to, 1);

    const [integrity, retention, erasure, audit] = await Promise.all([
      this.getIntegrityByDay(from, toExclusive),
      this.getRetentionSnapshot(),
      this.getErasureByDay(from, toExclusive),
      this.getAuditByDay(from, toExclusive),
    ]);

    return { period: { from, to }, generatedAt: new Date().toISOString(),
             integrity, retention, erasure, audit };
  }

  // ---- date range helpers ----
  private resolveRange(from?: string, to?: string) {
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const resolvedTo = to ?? iso(new Date());
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
    const rows = await this.batchesRepo.createQueryBuilder('batch')
      .select(`to_char(date_trunc('day', batch.sealed_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD')`, 'day')
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='CONFIRMED')`, 'confirmed')
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='TAMPERED')`, 'tampered')
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='UNVERIFIED')`, 'unverified')
      .addSelect(`COUNT(*) FILTER (WHERE batch.status='PENDING')`, 'pending')
      .addSelect('COUNT(*)', 'total')
      .where(`(batch.sealed_at AT TIME ZONE 'Asia/Bangkok') >= :from::timestamp
              AND (batch.sealed_at AT TIME ZONE 'Asia/Bangkok') < :toExclusive::timestamp`,
             { from, toExclusive })
      .groupBy('day').orderBy('day', 'ASC')
      .getRawMany();

    return rows.map(r => {
      const total = +r.total, confirmed = +r.confirmed;
      return { day: r.day, confirmed, tampered: +r.tampered,
               unverified: +r.unverified, pending: +r.pending, total,
               integrityRate: total ? Math.round((confirmed / total) * 100) : 0 };
    });
  }

  // ---- ② retention snapshot (as of now) ----
  private async getRetentionSnapshot() {
    const row = await this.logsRepo.createQueryBuilder('log')
      .select(`COUNT(*) FILTER (WHERE log.created_at + (log.retention_days || ' days')::interval < now())`, 'expired')
      .addSelect(`COUNT(*) FILTER (WHERE log.created_at + (log.retention_days || ' days')::interval BETWEEN now() AND now() + interval '30 days')`, 'due_in_30d')
      .addSelect(`COUNT(*) FILTER (WHERE log.cde_scope)`, 'cde_scoped')
      .addSelect('COUNT(*)', 'total')
      .getRawOne();
    return { expired: +row.expired, dueIn30d: +row.due_in_30d,
             cdeScoped: +row.cde_scoped, total: +row.total };
  }

  // ---- ③ erasure per day (JSON file) ----
  private getErasureByDay(from: string, toExclusive: string) {
    const records = this.readErasureLog();
    const dateOf = (r: any) => r.erasedAt ?? r.requestedAt ?? r.date ?? r.at ?? r.timestamp;
    const byDay = new Map<string, any[]>();
    for (const rec of records) {
      const raw = dateOf(rec);
      if (!raw) continue;
      const day = this.bangkokDay(raw);
      if (day < from || day >= toExclusive) continue;
      (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(rec);
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, recs]) => ({ day, requests: recs.length, records: recs }));
  }
  private readErasureLog(): any[] {
    if (!fs.existsSync(this.erasureLogPath)) return [];
    try {
      const p = JSON.parse(fs.readFileSync(this.erasureLogPath, 'utf-8'));
      return Array.isArray(p) ? p : [];
    } catch { return []; }
  }

  // ---- ④ audit per day ----
  private async getAuditByDay(from: string, toExclusive: string) {
    const rows = await this.auditRepo.createQueryBuilder('audit')
      .select(`to_char(date_trunc('day', audit.accessed_at AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD')`, 'day')
      .addSelect('audit.action', 'action')
      .addSelect('COUNT(*)', 'count')
      .where(`(audit.accessed_at AT TIME ZONE 'Asia/Bangkok') >= :from::timestamp
              AND (audit.accessed_at AT TIME ZONE 'Asia/Bangkok') < :toExclusive::timestamp`,
             { from, toExclusive })
      .groupBy('day').addGroupBy('audit.action').orderBy('day', 'ASC')
      .getRawMany();

    const map = new Map<string, Record<string, number>>();
    for (const r of rows) {
      if (!map.has(r.day)) map.set(r.day, {});
      map.get(r.day)![r.action] = +r.count;
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([day, byAction]) => ({ day, byAction }));
  }
}