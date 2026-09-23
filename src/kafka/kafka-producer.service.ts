import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { buildKafkaSsl } from './kafka-ssl.config';
import { PendingLog } from './entities/pending-log.entity';

export interface LogEvent {
  id: string;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  rawHash: string;
  cdeScope: boolean;
  createdAt: string;
}

/**
 * การเชื่อมต่อ: retry ไม่มีวันยอมแพ้ (exponential backoff cap 60 วิ) แบบเดียวกับ
 * KafkaConsumerService — ของเดิมลอง connect ครั้งเดียวตอน boot แล้ว
 * "log publishing disabled" ถาวร ซึ่งเกิดทุกครั้งที่ compose ยก backend ขึ้นก่อน broker
 * พร้อม: log ยังเข้า DB ได้ 201 ตามปกติ แต่ไม่มีอะไรไปถึง logs.raw เลย
 * detection จึงไม่เห็นอะไรทั้ง run โดยไม่มีใครรู้ จนกว่าจะ restart backend เอง
 */
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer: Producer;
  private isConnected = false;

  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private shuttingDown = false;
  /** ปลุก backoff ที่กำลังรออยู่ให้ตื่นทันที (ใช้ตอน shutdown) */
  private wakeUp: (() => void) | null = null;
  /** ให้เทส (และ onModuleDestroy) รอ loop จบได้ ไม่ต้องเดาเวลา */
  private loopDone: Promise<void> = Promise.resolve();
  /** log ที่เข้าคิวระหว่างยังต่อไม่ติด — เตือนครั้งเดียวต่อช่วง ไม่ให้ท่วม log */
  private queuedWarned = false;
  /** จำนวน log ต่อรอบที่ดึงจาก outbox มา replay */
  private readonly drainBatchSize = 500;
  /** มี log ค้างคิวอยู่ไหม — กันไม่ให้ยิง query หาคิวเปล่าทุกครั้งที่ ingest */
  private hasPending = true;
  /** กัน drain ซ้อนกันเอง (connect สำเร็จ + ส่งสำเร็จพร้อมกัน) */
  private draining = false;

  constructor(
    cfg: ConfigService,
    @InjectRepository(PendingLog)
    private readonly pendingRepo: Repository<PendingLog>,
  ) {
    const kafka = new Kafka({
      clientId: 'api-gateway',
      brokers: cfg.get<string>('KAFKA_BROKERS', 'kafka-1:9092').split(','),
      ...buildKafkaSsl(cfg),
      retry: { retries: 1, initialRetryTime: 100 },
      logLevel: 1,
    });
    this.producer = kafka.producer({ idempotent: true });

    this.backoffBaseMs = Number(cfg.get('KAFKA_RECONNECT_BASE_MS', 1000));
    this.backoffMaxMs = Number(cfg.get('KAFKA_RECONNECT_MAX_MS', 60000));
  }

  onModuleInit() {
    // ตั้งใจไม่ await: retry ไม่มีที่สิ้นสุด ถ้า await จะทำให้ Nest boot ค้างรอ Kafka
    this.loopDone = this.connectLoop();
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    this.wakeUp?.(); // ไม่ต้องรอ backoff ที่ค้างอยู่ให้ครบ 60 วิ
    await this.loopDone;
    if (this.isConnected) {
      await this.producer.disconnect();
    }
  }

  private async connectLoop(): Promise<void> {
    for (let attempt = 1; !this.shuttingDown; attempt++) {
      try {
        await this.producer.connect();
        this.isConnected = true;
        this.queuedWarned = false;
        this.logger.log(`Kafka connected — attempt ${attempt}`);
        // log ที่ค้างคิวไว้ต้องตามไปให้ detection — ไม่ await: ต่อติดแล้วไม่ควรค้างรอ replay
        void this.drainPending();
        return;
      } catch (err) {
        if (this.shuttingDown) return;
        const delay = Math.min(
          this.backoffBaseMs * 2 ** (attempt - 1),
          this.backoffMaxMs,
        );
        // log ทุกครั้ง — ต้องเห็นได้ว่ายังพยายามอยู่ ไม่ได้ตายไปแล้ว
        this.logger.warn(
          `Kafka producer connect failed (attempt ${attempt}): ${(err as Error).message} — ` +
            `ลองใหม่ใน ${Math.round(delay / 1000)}s (ไม่ยอมแพ้)`,
        );
        await this.sleep(delay);
      }
    }
  }

  /** sleep ที่ shutdown ปลุกให้ตื่นก่อนกำหนดได้ — ไม่ให้ปิดแอปค้างรอ backoff 60 วิ */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      // ไม่กัน event loop ไว้ (ไม่งั้น jest/process ไม่ยอมจบระหว่างรอ retry)
      timer.unref?.();
      this.wakeUp = finish;
    });
  }

  async publishLog(event: LogEvent): Promise<void> {
    // ยังต่อไม่ติด (compose ยก backend ขึ้นก่อน broker / Kafka ล่ม) — เข้าคิวไว้ก่อน
    // ของเดิม return เฉย ๆ: log อยู่ใน DB ครบแต่ detection ไม่เคยเห็น ไม่มีใคร replay
    if (!this.isConnected) {
      await this.enqueue(event, 'Kafka ยังไม่พร้อม');
      return;
    }

    try {
      await this.send(event);
      // ส่งได้แปลว่า broker กลับมาแล้ว — ถ้ามี log ค้างคิวจากช่วงที่ล่ม ตามไปส่งให้ครบ
      // (broker ที่ล่มหลังต่อติดแล้ว kafkajs จัดการ reconnect เอง ไม่ผ่าน connectLoop
      //  จึงรอ drain ตอน connect อย่างเดียวไม่ได้ — คิวจะค้างจนกว่าจะ restart)
      if (this.hasPending) void this.drainPending();
    } catch (err) {
      // DLQ fallback — log ที่ส่งไม่สำเร็จต้องไม่หายเงียบ
      this.logger.error(
        `Kafka publish failed, routing to DLQ: ${(err as Error).message}`,
      );
      try {
        await this.producer.send({
          topic: 'logs.raw.dlq',
          messages: [
            {
              key: event.source,
              value: JSON.stringify(event),
              headers: {
                'original-topic': 'logs.raw',
                error: (err as Error).message,
                'failed-at': new Date().toISOString(),
              },
            },
          ],
        });
        this.logger.warn(`Log ${event.id} routed to DLQ`);
      } catch (dlqErr) {
        // DLQ ก็ไม่ไหว = broker มีปัญหาทั้งก้อน เก็บเข้าคิวไว้ส่งรอบหน้า ดีกว่าปล่อยหาย
        this.logger.error(`DLQ also failed for ${event.id}`, dlqErr);
        await this.enqueue(event, 'ส่ง DLQ ไม่สำเร็จ');
      }
    }
  }

  /** ส่งขึ้น logs.raw จริง — ใช้ร่วมกันทั้งตอน ingest และตอน replay */
  private async send(event: LogEvent): Promise<void> {
    await this.producer.send({
      topic: 'logs.raw',
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key: event.source,
          value: JSON.stringify(event),
          headers: { severity: event.severity, cde: String(event.cdeScope) },
        },
      ],
    });
  }

  /**
   * เก็บ log เข้า outbox — ingest ต้องไม่พังเพราะ Kafka ล่ม (log อยู่ใน DB แล้ว)
   * ถ้าคิวเองก็เขียนไม่ได้ ได้แค่ log ระดับ ERROR ให้เห็นว่า log นี้ไม่ถึง detection แน่ ๆ
   */
  private async enqueue(event: LogEvent, reason: string): Promise<void> {
    try {
      // ONFLICT: log เดิมอยู่ในคิวแล้ว (retry ของ caller) ไม่ต้องเขียนซ้ำ
      await this.pendingRepo
        .createQueryBuilder()
        .insert()
        .into(PendingLog)
        .values({ logId: event.id, payload: event })
        .orIgnore()
        .execute();
      this.hasPending = true;

      if (!this.queuedWarned) {
        this.queuedWarned = true;
        this.logger.warn(
          `${reason} — log เข้าคิวไว้ใน kafka_pending_logs แล้วจะส่งให้ detection เมื่อต่อติด`,
        );
      }
    } catch (err) {
      this.logger.error(
        `CRITICAL: log ${event.id} ไม่ถึง Kafka และเข้าคิวไม่ได้: ${(err as Error).message}`,
      );
    }
  }

  /**
   * ส่ง log ที่ค้างคิวตามไปให้ detection เรียงตามเวลาที่เข้าคิว (ลำดับเดิมของ log)
   *
   * ลบทีละใบหลังส่งสำเร็จ — at-least-once: ถ้าลบไม่สำเร็จหลังส่ง รอบหน้าจะส่งซ้ำ
   * ซึ่งยอมรับได้ ดีกว่าลบก่อนส่งแล้ว log หายถ้า broker พังกลางทาง
   */
  private async drainPending(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    let sent = 0;
    try {
      for (;;) {
        const batch = await this.pendingRepo.find({
          order: { queuedAt: 'ASC' },
          take: this.drainBatchSize,
        });
        if (batch.length === 0) {
          this.hasPending = false;
          break;
        }

        for (const row of batch) {
          if (!this.isConnected || this.shuttingDown) return;
          await this.send(row.payload);
          await this.pendingRepo.delete({ logId: row.logId });
          sent++;
        }
      }
    } catch (err) {
      // ที่เหลือยังอยู่ในคิว — รอบ connect ถัดไปมาเก็บต่อ
      this.logger.warn(
        `Replay log ที่ค้างคิวไม่ครบ (ส่งไปแล้ว ${sent}): ${(err as Error).message}`,
      );
      return;
    } finally {
      this.draining = false;
    }
    if (sent > 0) {
      this.logger.log(`Replay ${sent} log ที่ค้างคิวขึ้น logs.raw แล้ว`);
    }
  }
}
