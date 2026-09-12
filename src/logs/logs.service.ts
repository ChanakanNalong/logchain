import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from 'typeorm';
import { randomUUID } from "crypto";
import { Log } from "./entities/log.entity";
import { CreateLogDto } from './dto/create-log.dto';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PiiMaskingService } from "./services/pii-masking.service";
import { MetricsService } from '../metrics/metrics.service';
import { computeRawHash, normalizeIp } from './services/log-hash';

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
        })

        this.metrics.incrementLogsIngested(dto.severity);
        this.metrics.recordIngestDuration(Date.now() - startTime);
        return saved;
    }

    findOne(id: string) {
        return this.repo.findOneBy({ id });
    }

    findRecent(limit = 100) {
        return this.repo.find({
            order: { createdAt: 'DESC' },
            take: Math.min(limit, 1000), // ป้องกัน query ขนาดใหญ่เกินไป
        });
    }
}