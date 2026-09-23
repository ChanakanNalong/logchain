import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { Repository } from 'typeorm';
import { Batch } from '../logs/entities/batch.entity';

type BatchStatusRow = { status: string; n: string; oldest: string | null };

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);
  private readonly registry = new Registry();
  private readonly logsTotal: Counter;
  private readonly ingestHist: Histogram;
  private readonly piiCounter: Counter;
  private readonly ethersRejections: Counter;
  private readonly batchesByStatus: Gauge;
  private readonly batchOldestAge: Gauge;
  private batchQueryFailing = false;
  private batchStatsInFlight: Promise<void> | null = null;

  constructor(
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'logchain_' });

    this.logsTotal = new Counter({
      name: 'logchain_logs_ingested_total',
      help: 'Total logs ingested',
      labelNames: ['severity'],
      registers: [this.registry],
    });
    this.ingestHist = new Histogram({
      name: 'logchain_ingest_duration_ms',
      help: 'Ingest latency (ms)',
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });
    this.piiCounter = new Counter({
      name: 'logchain_pii_masked_total',
      help: 'Logs with PII masked',
      registers: [this.registry],
    });
    this.ethersRejections = new Counter({
      name: 'logchain_unhandled_ethers_rejections_total',
      help: 'ethers promise rejections that escaped every await (process kept alive)',
      labelNames: ['code'],
      registers: [this.registry],
    });

    // สถานะ batch อ่านจาก DB ตอน scrape — ใช้ตั้ง alert "batch ค้าง UNVERIFIED" (INTEGRITY_AUTO_REANCHOR=false
    // แล้ว tx ถูก drop = ค้างเงียบ ๆ ไม่มีใครส่งใหม่) · query เดียวเติมทั้งสอง gauge: registry เรียก collect
    // ของทุก metric **พร้อมกัน** (ไม่ใช่ตามลำดับ) ทั้งสองตัวจึงต้องรอ promise ตัวเดียวกัน
    this.batchesByStatus = new Gauge({
      name: 'logchain_batches',
      help: 'Batches by status (read from DB at scrape time)',
      labelNames: ['status'],
      registers: [this.registry],
      collect: () => this.refreshBatchStats(),
    });
    this.batchOldestAge = new Gauge({
      name: 'logchain_batch_oldest_age_seconds',
      help: 'Seconds since sealed_at of the oldest batch in each status',
      labelNames: ['status'],
      registers: [this.registry],
      collect: () => this.refreshBatchStats(),
    });
  }

  /** scrape เดียว = query เดียว — collect ของสอง gauge ที่มาพร้อมกันได้ promise ตัวเดียวกัน */
  private refreshBatchStats(): Promise<void> {
    this.batchStatsInFlight ??= this.collectBatchStats().finally(() => {
      this.batchStatsInFlight = null;
    });
    return this.batchStatsInFlight;
  }

  /**
   * DB ล่ม → ไม่โยน: ถ้าโยน /metrics ทั้งก้อนพัง แล้ว ServiceDown ของ backend เด้งหลอก
   * (DB ล่มมี PostgresDown เตือนอยู่แล้ว) · ล้างค่าเดิมทิ้ง ไม่ปล่อยตัวเลขเก่าค้างเหมือนยังจริง
   * log เฉพาะตอนเริ่มพัง/หาย ไม่ log ซ้ำทุก 15 วิ
   */
  private async collectBatchStats(): Promise<void> {
    this.batchesByStatus.reset();
    this.batchOldestAge.reset();
    let rows: BatchStatusRow[];
    try {
      rows = await this.batchesRepo
        .createQueryBuilder('b')
        .select('b.status', 'status')
        .addSelect('COUNT(*)', 'n')
        .addSelect('EXTRACT(EPOCH FROM (now() - MIN(b.sealed_at)))', 'oldest')
        .groupBy('b.status')
        .getRawMany<BatchStatusRow>();
    } catch (err) {
      if (!this.batchQueryFailing) {
        this.logger.warn(
          `batch metrics unavailable: ${(err as Error).message}`,
        );
      }
      this.batchQueryFailing = true;
      return;
    }
    if (this.batchQueryFailing) this.logger.log('batch metrics recovered');
    this.batchQueryFailing = false;

    for (const r of rows) {
      this.batchesByStatus.set({ status: r.status }, Number(r.n));
      if (r.oldest !== null) {
        this.batchOldestAge.set({ status: r.status }, Number(r.oldest));
      }
    }
  }

  incrementLogsIngested(severity: string) {
    this.logsTotal.inc({ severity });
  }
  recordIngestDuration(ms: number) {
    this.ingestHist.observe(ms);
  }
  incrementPiiMasked() {
    this.piiCounter.inc();
  }
  incrementUnhandledEthersRejection(code: string) {
    this.ethersRejections.inc({ code });
  }

  async getMetrics() {
    return this.registry.metrics();
  }
  getContentType() {
    return this.registry.contentType;
  }
}
