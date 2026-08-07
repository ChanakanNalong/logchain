import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from 'typeorm';
import { createHash } from "crypto";
import { Log } from "./entities/log.entity";
import { CreateLogDto } from './dto/create-log.dto';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PiiMaskingService } from "./services/pii-masking.service";
import { MetricsService } from '../metrics/metrics.service';

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

        // Step 2: hash ข้อความที่ mask แล้วเท่านั้น
        const rawHash = createHash('sha256')
            .update(JSON.stringify({
                source: dto.source,
                eventType: dto.eventType,
                message: masked,
            }))
            .digest('hex');

        // Step 3: บันทึกลง PostgreSQL
        const log = this.repo.create({
            source: dto.source,
            sourceIp: dto.sourceIp ?? null,
            eventType: dto.eventType,
            severity: dto.severity,
            message: masked,
            rawHash,
            classification: dto.classification,
            cdeScope: dto.cdeScope ?? false,
            retentionDays: dto.retentionDays ?? 365,
        });
        const saved = await this.repo.save(log);

        // Step 4: ส่งไป Kafka เพื่อให้ Detection service วิเคราะห์
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