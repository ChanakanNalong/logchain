import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { IntegrityService } from './integrity.service';

/** ชื่อ cron ของรอบ seal ใน SchedulerRegistry */
export const SEAL_CRON_JOB = 'integrity-seal';

@Injectable()
export class IntegritySchedule implements OnModuleInit {
  private readonly logger = new Logger(IntegritySchedule.name);

  constructor(
    private readonly integrity: IntegrityService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  // seal ตาม SEAL_CRON (default ทุก 1 นาที) — ลงทะเบียนเองแทน @Cron เพราะ decorator
  // ถูกประเมินตอน import ก่อน ConfigModule โหลด .env (โหมด dev บน host จะไม่เห็นค่า)
  // cron expression ผิด → CronJob โยนตอน boot (ดีกว่าเงียบแล้วไม่ seal เลย)
  onModuleInit() {
    const { cron, batchSize } = this.integrity.sealConfig;
    const job = new CronJob(cron, () => void this.handleSealBatch());
    this.scheduler.addCronJob(SEAL_CRON_JOB, job);
    job.start();
    this.logger.log(`Seal schedule: "${cron}" · batch size ${batchSize}`);
  }

  async handleSealBatch() {
    try {
      await this.integrity.runScheduledSeal();
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
