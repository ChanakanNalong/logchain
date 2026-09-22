import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IntegrityService } from './integrity.service';

@Injectable()
export class IntegritySchedule {
  private readonly logger = new Logger(IntegritySchedule.name);

  constructor(private readonly integrity: IntegrityService) {}

  // seal batch ทุก 1 นาที (CronExpression.EVERY_MINUTE)
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
      // batch ที่ seal ไว้ตอนยังไม่มี chain — ตรึงขึ้น chain ให้ก่อน
      // (no-op ถ้าไม่มี SEALED ค้าง หรือ chain ยังไม่พร้อม)
      await this.integrity.anchorSealedBatches();
      await this.integrity.reanchorUnverified();
      await this.integrity.verifyAllBatches();
    } catch (err) {
      this.logger.error('Verify job failed', err);
    }
  }
}
