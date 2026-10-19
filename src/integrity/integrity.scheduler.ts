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

  // ลงทะเบียน job seal เองแทน @Cron เพราะ decorator ถูกประเมินตอน import ก่อน ConfigModule
  // โหลด .env (โหมด dev บน host จะไม่เห็นค่า) · cron expression ผิด → CronJob โยนตอน boot
  //
  // mode=cron (default): seal ตาม SEAL_CRON (default ทุก 1 นาที) — พฤติกรรมเดิมทุกอย่าง
  // mode=hybrid: เช็คทุก 1 นาที (count|age) และ "ไม่" ลงทะเบียน hourly cron (กัน seal ซ้ำ)
  onModuleInit() {
    const { mode, cron, batchSize, maxWaitMinutes } = this.integrity.sealConfig;

    if (mode === 'hybrid') {
      const job = new CronJob(
        CronExpression.EVERY_MINUTE,
        () => void this.handleHybridTick(),
      );
      this.scheduler.addCronJob(SEAL_CRON_JOB, job);
      job.start();
      this.logger.log(
        `Seal schedule: hybrid (ทุก 1 นาที) · batch size ${batchSize} · max wait ${maxWaitMinutes} นาที`,
      );
      return;
    }

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

  async handleHybridTick() {
    try {
      await this.integrity.runHybridSealTick();
    } catch (err) {
      this.logger.error('Hybrid seal tick failed', err);
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
