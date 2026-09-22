import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Log } from '../logs/entities/log.entity';
import { Batch, INTACT_STATUSES } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import {
  BUCKETS,
  BucketKey,
  DEFAULT_TRAFFIC_RANGE,
  MAX_BUCKETS,
  RANGE_SPECS,
  TrafficRange,
  pickBucketForSpan,
} from './traffic-ranges';

/** Batch statuses seeded so the shape stays stable on an empty database. */
const BATCH_STATUSES = [
  'CONFIRMED',
  'SEALED',
  'UNVERIFIED',
  'TAMPERED',
  'PENDING',
] as const;

export interface TrafficPoint {
  /** ต้นชั่วโมง/ต้นวัน ฯลฯ ของ bucket เป็น ISO UTC — ให้ frontend เรียงหรือ format เองได้ */
  t: string;
  /** ป้ายแกน X ที่ format มาแล้วตามความกว้างของ bucket */
  label: string;
  total: number;
}

export interface TrafficSeries {
  range: TrafficRange;
  /** คำเรียก bucket สำหรับป้าย "Events per …" เช่น hour, day, week */
  bucket: string;
  points: TrafficPoint[];
}

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
  anomalyTypes: {
    type: string;
    severity: string;
    source: string;
    count: number;
  }[];
}

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(Log) private readonly logsRepo: Repository<Log>,
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    @InjectRepository(Alert) private readonly alertsRepo: Repository<Alert>,
  ) {}

  async getOverview(): Promise<StatsOverview> {
    const [totalLogs, batches, openAlerts, traffic, topSources, anomalyTypes] =
      await Promise.all([
        this.logsRepo.count(),
        this.getBatchStats(),
        this.alertsRepo.count({ where: { status: 'OPEN' } }),
        this.getTraffic(DEFAULT_TRAFFIC_RANGE),
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
      integrityRate:
        batches.total === 0
          ? 0
          : Math.round((batches.intact / batches.total) * 100),
      openAlerts,
      // overview ยังคงสัญญาเดิมไว้ ({ h, total } 24 ชั่วโมง) — หน้า dashboard ที่เลือก
      // ช่วงเวลาได้ย้ายไปเรียก /stats/traffic แทนแล้ว
      traffic: traffic.points.map((p) => ({ h: p.label, total: p.total })),
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
      // batch FAILED ตั้ง status แล้ว return ก่อนใส่ mapping — log_count มีแต่ไม่มี log ผูกจริง
      // จึงต้องกันออกจากทั้ง sealedLogs และ total:
      // total เป็นตัวหารของ integrityRate ถ้านับ FAILED ด้วย แค่ anchor พลาด
      // (RPC ล่ม / gas ไม่พอ) ก็ทำให้ integrity ตกทั้งที่ไม่มีอะไรถูกแก้เลย
      // -> dashboard จะขึ้น "integrity 75%" คู่กับ "0 tampered" ซึ่งขัดกันเอง
      // ยังคง FAILED ไว้ใน byStatus เพื่อให้เห็นว่า anchor พลาดกี่ใบ
      if (row.status !== 'FAILED') {
        total += count;
        sealedLogs += parseInt(row.log_count, 10) || 0;
      }
    }
    return {
      byStatus,
      total,
      sealedLogs,
      confirmed: byStatus.CONFIRMED ?? 0,
      intact: INTACT_STATUSES.reduce((n, st) => n + (byStatus[st] ?? 0), 0),
      tampered: byStatus.TAMPERED ?? 0,
    };
  }

  /**
   * ซีรีส์จำนวน log ต่อ bucket ของช่วงเวลาที่เลือก (ค่าตั้งต้น 24h)
   *
   * generate_series + LEFT JOIN => ได้ครบทุก bucket เสมอ ช่วงที่ไม่มี log จะเป็น 0
   * (ไม่ใช่ "ไม่มีแถว") กราฟฝั่ง dashboard จึงไม่ขาดช่วง
   *
   * bucket เป็น **UTC** แบบบังคับด้วย `AT TIME ZONE 'UTC'` ไม่ปล่อยตาม session
   * timezone ของ DB — ฝั่ง dashboard ติดป้าย "(UTC)" ไว้ ถ้าใครตั้ง TZ ใหม่แล้ว
   * bucket เลื่อนตาม ป้ายนั้นจะกลายเป็นคำโกหกทันที
   * (หมายเหตุ: นาฬิกาบนหัวแอปเป็น ICT = UTC+7 คนละโซนกับกราฟนี้โดยตั้งใจ)
   *
   * เงื่อนไข `l.created_at >= <ต้นซีรีส์>` ใน ON ไม่ได้มีไว้กรอง (การ join แบบ
   * เท่ากับ bucket กรองให้อยู่แล้ว) แต่มีไว้ให้ planner ใช้ idx_logs_created_at ได้
   * ฝั่งซ้ายต้องเป็นคอลัมน์เปล่าๆ — date_bin/date_trunc ครอบเมื่อไหร่ index หลุดทันที
   * ไม่มีบรรทัดนี้ = seq scan ตาราง logs ทั้งใบทุกครั้งที่เปิด dashboard แม้แต่ช่วง 1H
   * และต้องอยู่ใน ON ไม่ใช่ WHERE ไม่งั้น LEFT JOIN กลายเป็น INNER แล้ว bucket
   * ที่ไม่มี log จะหายไปจากกราฟแทนที่จะเป็น 0
   */
  async getTraffic(
    range: TrafficRange = DEFAULT_TRAFFIC_RANGE,
  ): Promise<TrafficSeries> {
    const plan =
      range === 'all' ? await this.planAllRange() : RANGE_SPECS[range];
    // 'all' บน DB ที่ยังไม่มี log สักแถว — ไม่มีจุดเริ่ม จึงไม่มีอะไรให้ plot
    if (!plan) {
      return {
        range,
        bucket: BUCKETS[RANGE_SPECS['24h'].bucket].name,
        points: [],
      };
    }

    const spec = BUCKETS[plan.bucket];
    const label = spec.labelFormat;
    const rows: any[] = spec.truncUnit
      ? await this.logsRepo.query(
          `
      SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
             to_char(b.bucket, $3) AS label,
             COUNT(l.id) AS total
      FROM generate_series(
             date_trunc($1::text, (now() AT TIME ZONE 'UTC')) - $2::interval,
             date_trunc($1::text, (now() AT TIME ZONE 'UTC')),
             $4::interval
           ) AS b(bucket)
      LEFT JOIN logs l
             ON date_trunc($1::text, l.created_at AT TIME ZONE 'UTC') = b.bucket
            AND l.created_at >= (
                  (date_trunc($1::text, (now() AT TIME ZONE 'UTC')) - $2::interval)
                  AT TIME ZONE 'UTC'
                )
      GROUP BY b.bucket
      ORDER BY b.bucket ASC;
    `,
          [
            spec.truncUnit,
            `${plan.points - 1} ${spec.truncUnit}s`,
            label,
            spec.step,
          ],
        )
      : await this.logsRepo.query(
          `
      SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
             to_char(b.bucket, $3) AS label,
             COUNT(l.id) AS total
      FROM generate_series(
             date_bin($1::interval, (now() AT TIME ZONE 'UTC') - $2::interval, $4::timestamp),
             date_bin($1::interval, (now() AT TIME ZONE 'UTC'), $4::timestamp),
             $1::interval
           ) AS b(bucket)
      LEFT JOIN logs l
             ON date_bin($1::interval, l.created_at AT TIME ZONE 'UTC', $4::timestamp) = b.bucket
            AND l.created_at >= (
                  date_bin($1::interval, (now() AT TIME ZONE 'UTC') - $2::interval, $4::timestamp)
                  AT TIME ZONE 'UTC'
                )
      GROUP BY b.bucket
      ORDER BY b.bucket ASC;
    `,
          [
            spec.step,
            `${(plan.points - 1) * spec.seconds} seconds`,
            label,
            spec.origin,
          ],
        );

    return {
      range,
      bucket: spec.name,
      // COUNT(l.id) ต้องมี `AS total` — ไม่งั้น Postgres ตั้งชื่อคอลัมน์ว่า "count"
      // แล้ว row.total เป็น undefined -> parseInt(undefined) = NaN -> ตกไปเป็น 0 ทุก bucket
      // (กราฟจะแบนเป็นศูนย์ทั้งแถบทั้งที่มี log จริง)
      points: rows.map((row) => ({
        t: row.t,
        label: row.label,
        total: parseInt(row.total, 10) || 0,
      })),
    };
  }

  /**
   * 'all' ไม่มีความกว้างตายตัว — เลือก bucket จากอายุของ log ที่เก่าที่สุด
   * แล้วนับจำนวน bucket ที่ต้องใช้คลุมถึงปัจจุบัน (ไม่เกิน MAX_BUCKETS)
   */
  private async planAllRange(): Promise<{
    bucket: BucketKey;
    points: number;
  } | null> {
    // ดึงเป็น timestamptz ตรงๆ (ไม่ใส่ AT TIME ZONE) — driver จะ parse ได้เป็นเวลาจริง
    // ถ้าแปลงเป็น timestamp เปล่าก่อน driver จะอ่านเป็นเวลาท้องถิ่นแล้วเพี้ยนไปตาม TZ ของ API
    const [row] = await this.logsRepo.query(
      `SELECT min(created_at) AS first FROM logs;`,
    );
    if (!row?.first) return null;

    const first = new Date(row.first);
    const now = new Date();
    const spanMs = Math.max(0, now.getTime() - first.getTime());
    const bucket = pickBucketForSpan(spanMs);
    const spec = BUCKETS[bucket];

    let points: number;
    if (spec.truncUnit === 'year') {
      points = now.getUTCFullYear() - first.getUTCFullYear() + 1;
    } else if (spec.truncUnit === 'month') {
      points =
        (now.getUTCFullYear() - first.getUTCFullYear()) * 12 +
        (now.getUTCMonth() - first.getUTCMonth()) +
        1;
    } else {
      // +1 เผื่อ bucket ที่ log แรกตกอยู่: bucket เรียงบน grid คงที่ ถ้า log แรกอยู่
      // ท้าย bucket (เช่น 10:59 กับตอนนี้ 11:01) span จะสั้นกว่าจำนวน bucket จริง
      points = Math.ceil(spanMs / 1000 / spec.seconds) + 1;
    }
    return { bucket, points: Math.min(Math.max(points, 1), MAX_BUCKETS) };
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

    return rows.map((row) => ({
      ip: row.ip,
      hits: parseInt(row.hits, 10) || 0,
    }));
  }

  private async getAnomalyTypes() {
    const rows = await this.alertsRepo
      .createQueryBuilder('a')
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
    return rows.map((r) => ({
      type: r.type,
      severity: r.severity,
      source: r.source,
      count: +r.count,
    }));
  }
}
