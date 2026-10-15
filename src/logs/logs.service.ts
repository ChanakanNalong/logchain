import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Log } from './entities/log.entity';
import { CreateLogDto } from './dto/create-log.dto';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PiiMaskingService } from './services/pii-masking.service';
import { MetricsService } from '../metrics/metrics.service';
import { computeRawHash, normalizeIp } from './services/log-hash';
import { ListLogsQuery } from './dto/list-logs.query';
import { explorerTxUrl } from '../blockchain/explorer';

/** log หนึ่งแถวของ GET /logs — field เดิมของ Log + สถานะ batch ที่ผูกอยู่ */
export interface LogListItem {
  id: string;
  createdAt: Date;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  classification: string;
  cdeScope: boolean;
  retentionDays: number;
  rawHash: string;
  batchId: string | null;
  /** null = ยังไม่ถูก seal */
  batchStatus: string | null;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
}

export interface LogPage {
  items: LogListItem[];
  total: number;
  limit: number;
  offset: number;
}

interface LogListRow {
  id: string;
  created_at: Date;
  source: string;
  source_ip: string | null;
  event_type: string;
  severity: string;
  message: string;
  classification: string;
  cde_scope: boolean;
  retention_days: number;
  raw_hash: string;
  batch_id: string | null;
  batch_status: string | null;
  tx_hash: string | null;
  block_number: string | number | null;
  total?: string | number;
}

/** "a, b,,c" → ['a','b','c'] · ว่าง = null (ไม่กรอง) */
function csv(raw: string | undefined): string[] | null {
  const list = (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 100);
  return list.length ? list : null;
}

/** q ของผู้ใช้เป็นตัวอักษรล้วน — % _ \ ไม่ใช่ wildcard */
function likePattern(q: string | undefined): string | null {
  const t = q?.trim();
  return t ? `%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%` : null;
}

@Injectable()
export class LogService {
  private readonly logger = new Logger(LogService.name);

  constructor(
    // @InjectRepository -> ขอ TypeORM repository สำหรับ Log entity
    @InjectRepository(Log)
    private readonly repo: Repository<Log>,
    private readonly kafka: KafkaProducerService,
    private readonly pii: PiiMaskingService,
    private readonly metrics: MetricsService,
  ) {}

  async ingest(dto: CreateLogDto): Promise<Log> {
    const startTime = Date.now();

    // step 1: mask PII ก่อน (PCI-DSS Req 3)
    // ห้ามสลับลำดับ - PAN ต้องไม่เคยเข้า hash function
    const { masked, hadPii } = this.pii.mask(dto.message);
    if (hadPii) this.metrics.incrementPiiMasked();

    // Step 2: กำหนด id + createdAt เองก่อน hash
    // ตาราง logs มี trigger trg_logs_no_update บล็อก UPDATE → เขียน rawHash
    // กลับหลัง insert ไม่ได้ ต้องได้ค่าทุก field ครบก่อนแล้ว insert ครั้งเดียว
    const id = randomUUID();
    const createdAt = new Date();
    const sourceIp = normalizeIp(dto.sourceIp);

    // Step 3: hash ครอบทุก field ที่เป็นหลักฐาน (message = ข้อความที่ mask แล้วเท่านั้น)
    const rawHash = computeRawHash({
      id,
      source: dto.source,
      sourceIp,
      eventType: dto.eventType,
      severity: dto.severity,
      message: masked,
      classification: dto.classification,
      cdeScope: dto.cdeScope ?? false,
      createdAt,
    });

    // Step 4: บันทึกลง PostgreSQL (insert ครั้งเดียว — ไม่มี UPDATE ตามหลัง)
    const saved = this.repo.create({
      id,
      source: dto.source,
      sourceIp,
      eventType: dto.eventType,
      severity: dto.severity,
      message: masked,
      rawHash,
      classification: dto.classification,
      cdeScope: dto.cdeScope ?? false,
      retentionDays: dto.retentionDays ?? 365,
      createdAt,
    });
    await this.repo.insert(saved);

    // Step 5: ส่งไป Kafka เพื่อให้ Detection service วิเคราะห์
    await this.kafka.publishLog({
      id: saved.id,
      source: saved.source,
      sourceIp: saved.sourceIp,
      eventType: saved.eventType,
      severity: saved.severity,
      message: saved.message,
      rawHash: saved.rawHash,
      cdeScope: saved.cdeScope,
      createdAt: saved.createdAt.toISOString(),
    });

    this.metrics.incrementLogsIngested(dto.severity);
    this.metrics.recordIngestDuration(Date.now() - startTime);
    return saved;
  }

  async findOne(id: string): Promise<Log> {
    const log = await this.repo.findOneBy({ id });
    if (!log) throw new NotFoundException('Log not found');
    return log;
  }

  /**
   * GET /logs — แบ่งหน้า + กรอง + สถานะ batch ใน query เดียว (LEFT JOIN mapping → batches)
   * total มาจาก COUNT(*) OVER() ของ query เดียวกัน · หน้าที่เลยท้ายไปแล้ว (ไม่มีแถว) ค่อยนับแยก
   */
  async list(query: ListLogsQuery): Promise<LogPage> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const where = `
      WHERE ($1::text[] IS NULL OR l.source = ANY($1))
        AND ($2::text[] IS NULL OR l.severity = ANY($2))
        AND ($3::text[] IS NULL OR l.event_type = ANY($3))
        AND ($4::text IS NULL OR l.message ILIKE $4 ESCAPE '\\')`;
    const filters = [
      csv(query.source),
      csv(query.severity),
      csv(query.eventType),
      likePattern(query.q),
    ];

    const rows: LogListRow[] = await this.repo.query(
      `SELECT l.id, l.created_at, l.source, host(l.source_id) AS source_ip,
              l.event_type, l.severity, l.message, l.classification, l.cde_scope,
              l.retention_days, l.raw_hash,
              m.batch_id, b.status AS batch_status, b.tx_hash, b.block_number,
              COUNT(*) OVER () AS total
         FROM logs l
         LEFT JOIN log_batch_mapping m ON m.log_id = l.id
         LEFT JOIN batches b ON b.id = m.batch_id
         ${where}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT $5 OFFSET $6`,
      [...filters, limit, offset],
    );

    let total = rows.length ? Number(rows[0].total) : 0;
    if (!rows.length && offset > 0) {
      const counted: Array<{ count: string }> = await this.repo.query(
        `SELECT COUNT(*) AS count FROM logs l ${where}`,
        filters,
      );
      total = Number(counted[0]?.count ?? 0);
    }

    return { items: rows.map(toListItem), total, limit, offset };
  }
}

function toListItem(r: LogListRow): LogListItem {
  return {
    id: r.id,
    createdAt: new Date(r.created_at),
    source: r.source,
    sourceIp: r.source_ip,
    eventType: r.event_type,
    severity: r.severity,
    message: r.message,
    classification: r.classification,
    cdeScope: r.cde_scope,
    retentionDays: r.retention_days,
    rawHash: r.raw_hash,
    batchId: r.batch_id,
    batchStatus: r.batch_status,
    txHash: r.tx_hash,
    blockNumber: r.block_number === null ? null : Number(r.block_number),
    polygonscanUrl: explorerTxUrl(r.tx_hash),
  };
}
