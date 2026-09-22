import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { buildKafkaSsl } from './kafka-ssl.config';

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
  /** log ที่ข้ามไประหว่างยังต่อไม่ติด — เตือนครั้งเดียวต่อช่วง ไม่ให้ท่วม log */
  private skippedWarned = false;

  constructor(cfg: ConfigService) {
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
        this.skippedWarned = false;
        this.logger.log(`Kafka connected — attempt ${attempt}`);
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
    // ข้ามถ้า producer ยังไม่ connect (dev mode ไม่มี Kafka)
    // producer ถูกสร้างใน constructor เสมอ จึงต้องเช็ค isConnected ไม่ใช่ตัว producer
    if (!this.isConnected) {
      if (!this.skippedWarned) {
        this.skippedWarned = true;
        this.logger.warn(
          'Kafka ยังไม่พร้อม — log ถูกบันทึกลง DB แต่ไม่ถูกส่งไป detection จนกว่าจะต่อติด',
        );
      }
      return;
    }

    try {
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
        this.logger.error(`CRITICAL: DLQ also failed for ${event.id}`, dlqErr);
      }
    }
  }
}
