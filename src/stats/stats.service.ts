import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';

/** Batch statuses seeded so the shape stays stable on an empty database. */
const BATCH_STATUSES = ['CONFIRMED', 'UNVERIFIED', 'TAMPERED', 'PENDING'] as const;

export interface StatsOverview {
  totalLogs: number;
  sealedLogs: number;
  batches: {
    confirmed: number;
    tampered: number;
    total: number;
    byStatus: Record<string, number>;
  };
  integrityRate: number;
  openAlerts: number;
  traffic: { h: string; total: number }[];
  topSources: { ip: string; hits: number }[];
  anomalyTypes: { type: string; severity: string; source: string; count: number }[];
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Log) private readonly logsRepo: Repository<Log>,
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    @InjectRepository(Alert) private readonly alertsRepo: Repository<Alert>,
  ) {}

  async getOverview(): Promise<StatsOverview> {
    const [totalLogs, batches, openAlerts, traffic, topSources, anomalyTypes] = await Promise.all([
      this.logsRepo.count(),
      this.getBatchStats(),
      this.alertsRepo.count({ where: { status: 'OPEN' } }),
      this.getTrafficLast24h(),
      this.getTopSources(),
      this.getAnomalyTypes(),
    ]);

    return {
      totalLogs,
      sealedLogs: batches.sealedLogs,
      batches: {
        confirmed: batches.confirmed,
        tampered: batches.tampered,
        total: batches.total,
        byStatus: batches.byStatus,
      },
      // ยังไม่มี batch เลย -> 0 (อย่าให้กลายเป็น NaN จากการหารด้วยศูนย์)
      integrityRate: batches.total === 0
        ? 0
        : Math.round((batches.confirmed / batches.total) * 100),
      openAlerts,
      traffic,
      topSources,
      anomalyTypes,
    };
  }

  /** นับ batch แยกตาม status + รวม log_count เป็นจำนวน log ที่ถูก seal แล้ว */
  private async getBatchStats() {
    const rows = await this.batchesRepo
      .createQueryBuilder('batch')
      .select('batch.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .addSelect('COALESCE(SUM(batch.logCount), 0)', 'log_count')
      .groupBy('batch.status')
      .getRawMany();

    const byStatus: Record<string, number> = {};
    for (const status of BATCH_STATUSES) byStatus[status] = 0;

    let total = 0;
    let sealedLogs = 0;
    for (const row of rows) {
      const count = parseInt(row.count, 10) || 0;
      byStatus[row.status] = count;
      total += count;
      // batch FAILED ตั้ง status แล้ว return ก่อนใส่ mapping — log_count มีแต่ไม่มี log ผูกจริง
      if (row.status !== 'FAILED') {
        sealedLogs += parseInt(row.log_count, 10) || 0;
      }
    }
    return {
      byStatus,
      total,
      sealedLogs,
      confirmed: byStatus.CONFIRMED ?? 0,
      tampered: byStatus.TAMPERED ?? 0,
    };
  }

  /** จำนวน log ต่อชั่วโมงย้อนหลัง 24 ชม. — ชั่วโมงที่ไม่มี log จะไม่มีแถว */
  private async getTrafficLast24h() {
    const rows = await this.logsRepo.query(`
      SELECT to_char(hours.h, 'HH24:00') AS h,
              COUNT(l.id)
      FROM generate_series(
              date_trunc('hour', now() - interval '23 hours'),
              date_trunc('hour', now()),
              interval '1 hour'
          ) AS hours(h)
      LEFT JOIN logs l ON date_trunc('hour', l.created_at) = hours.h
      GROUP BY hours.h
      ORDER BY hours.h ASC;
    `);
    return rows.map((row: any) => ({ h: row.h, total: parseInt(row.total, 10) || 0 }));
  }

  /**
   * IP ที่ยิง log เข้ามามากที่สุด 5 อันดับ
   * ตาราง logs ไม่มีคอลัมน์ประเทศ/คะแนนความเสี่ยง จึงคืนแค่ ip กับ hits
   */
  private async getTopSources() {
    const rows = await this.logsRepo
      .createQueryBuilder('log')
      // ต้องอ้างชื่อคอลัมน์ตรงๆ — TypeORM ไม่แปลง `log.sourceIp` ให้เมื่อมี `::text` ต่อท้าย
      .select('host("log"."source_id")', 'ip')
      .addSelect('COUNT(*)', 'hits')
      .where('log.sourceIp IS NOT NULL')
      .groupBy('log.sourceIp')
      .orderBy('hits', 'DESC')
      .limit(5)
      .getRawMany();

    return rows.map((row) => ({ ip: row.ip, hits: parseInt(row.hits, 10) || 0 }));
  }

  private async getAnomalyTypes() {
    const rows = await this.alertsRepo.createQueryBuilder('a')
      .select('a.alertType', 'type')
      .addSelect('a.severity', 'severity')
      .addSelect('a.source', 'source')
      .addSelect('COUNT(*)', 'count')
      .where('a.source != :integritySource', { integritySource: 'INTEGRITY' })
      .groupBy('a.alertType')
      .addGroupBy('a.severity')
      .addGroupBy('a.source')
      .orderBy('count', 'DESC')
      .getRawMany();
    return rows.map(r => ({
      type: r.type, severity: r.severity, source: r.source, count: +r.count,
    }));
  }
}
