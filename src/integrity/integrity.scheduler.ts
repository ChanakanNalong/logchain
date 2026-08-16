import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from '@nestjs/schedule';
import { IntegrityService } from "./integrity.service";

@Injectable()
export class IntegritySchedule {
    private readonly logger = new Logger(IntegritySchedule.name);

    constructor(private readonly integrity: IntegrityService) {}

    // seal batch ทุก 30 นาที
    @Cron(CronExpression.EVERY_MINUTE)
    async handleSealBatch() {
        try {
            await this.integrity.sealBatch();
        } catch (err) {
            this.logger.error('Seal batch job failed', err);
        }
    }

    // verify ทุก batch ทุก 1 นาที (จับ tamper)
    @Cron(CronExpression.EVERY_MINUTE)
    async handlVerify() {
        try {
            await this.integrity.reanchorUnverified();
            await this.integrity.verifyAllBatches();
        } catch (err) {
            this.logger.error('Verify job failed', err);
        }
    }
}