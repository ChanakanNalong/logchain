import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer } from 'kafkajs';
import { buildKafkaSsl } from './kafka-ssl.config';
import { AlertsService } from '../alerts/alerts.service';

/**
 * payload ของ event `consumer.crash` จาก kafkajs
 * restart=true แปลว่า kafkajs จะ retry ให้เอง, false = หยุดแล้ว ต้องต่อใหม่เอง
 */
interface ConsumerCrashEvent {
  payload?: { error?: Error; restart?: boolean };
}

/** สถานะที่ /health เอาไปโชว์ (และ demo-preflight.sh เอาไป gate) */
export interface KafkaConsumerHealth {
  connected: boolean;
  lastError: string | null;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
}

/**
 * Consume alerts จาก detection service (Python) ผ่าน Kafka
 * → เขียนเข้า DB ผ่าน AlertsService.createOrDedup (+ email ถ้า CRITICAL)
 *
 * Topics:
 *   alerts.raw  — non-CDE alerts
 *   alerts.cde  — CDE-scoped alerts (PCI cardholder data env)
 *
 * การเชื่อมต่อ: retry ไม่มีวันยอมแพ้ (exponential backoff cap 60 วิ)
 * ของเดิม retry 5 ครั้ง (~30 วิ) แล้วหยุดถาวร ซึ่งพังจริงตอน `docker compose down -v`:
 * broker ใช้เวลา boot นานกว่านั้น backend ที่ค้างอยู่บน host จึงเลิกฟังไปเลย
 * alert ที่ detection ยิงมาหลังจากนั้นหายหมดโดยไม่มีใครรู้ จนกว่าจะ restart backend เอง
 */
@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private readonly consumer: Consumer;

  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  private connected = false;
  private attempts = 0;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;

  private shuttingDown = false;
  private looping = false;
  /** ปลุก backoff ที่กำลังรออยู่ให้ตื่นทันที (ใช้ตอน shutdown) */
  private wakeUp: (() => void) | null = null;
  /** ให้เทส (และ onModuleDestroy) รอ loop จบได้ ไม่ต้องเดาเวลา */
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    cfg: ConfigService,
    private readonly alertsService: AlertsService,
  ) {
    const kafka = new Kafka({
      clientId: 'api-gateway-consumer',
      brokers: cfg.get<string>('KAFKA_BROKERS', 'kafka-1:9092').split(','),
      ...buildKafkaSsl(cfg),
      retry: { retries: 8, initialRetryTime: 1000, maxRetryTime: 10000 },
      logLevel: 1,
    });
    this.consumer = kafka.consumer({ groupId: 'nestjs-alerts-persister' });

    this.backoffBaseMs = Number(cfg.get('KAFKA_RECONNECT_BASE_MS', 1000));
    this.backoffMaxMs = Number(cfg.get('KAFKA_RECONNECT_MAX_MS', 60000));

    // GROUP_JOIN = เข้ากลุ่มสำเร็จ กำลัง consume จริง
    // จำเป็นเพราะตอน kafkajs restart ให้เอง (restart=true) มันไม่ผ่าน connectLoop ของเรา
    // ถ้าไม่ดักตรงนี้ connected จะค้างเป็น false ตลอด ทั้งที่ consume ได้แล้ว → /health โกหก
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => {
      const wasDown = !this.connected;
      this.connected = true;
      this.lastError = null;
      this.lastConnectedAt = new Date();
      this.attempts = 0;
      if (wasDown) {
        this.logger.log(
          'Kafka consumer joined group — กำลังฟัง alerts.raw, alerts.cde',
        );
      }
    });

    this.consumer.on(this.consumer.events.DISCONNECT, () => {
      if (this.shuttingDown || !this.connected) return; // disconnect ที่เราสั่งเองระหว่าง retry
      this.connected = false;
      this.logger.warn('Kafka consumer disconnected — รอเชื่อมต่อใหม่');
    });

    // kafkajs หยุด consumer เองเมื่อ crash ด้วย error ที่ retry ไม่ได้ (restart=false)
    // ถ้าไม่ดักตรงนี้ process จะยังอยู่แต่ไม่มีใคร consume — เงียบแบบเดียวกับบั๊กเดิม
    this.consumer.on(
      this.consumer.events.CRASH,
      (event: ConsumerCrashEvent) => {
        this.connected = false;
        this.lastError = event?.payload?.error?.message ?? 'consumer crashed';
        if (this.shuttingDown) return;
        if (event?.payload?.restart) {
          // kafkajs retry ให้เองต่อไปเรื่อย ๆ — นับรวมไว้ด้วยไม่งั้น /health โชว์
          // reconnectAttempts=0 ทั้งที่กำลังพยายามอยู่ ดูเหมือนไม่มีอะไรเกิดขึ้น
          this.attempts++;
          this.logger.warn(
            `Kafka consumer crashed (ครั้งที่ ${this.attempts}): ${this.lastError} — ` +
              `kafkajs กำลัง restart ให้ (ไม่ยอมแพ้)`,
          );
          return;
        }
        this.logger.error(
          `Kafka consumer crashed (ไม่ restart เอง): ${this.lastError} — จะเชื่อมต่อใหม่`,
        );
        void this.startConnectLoop();
      },
    );
  }

  onModuleInit() {
    // ตั้งใจไม่ await: retry ไม่มีที่สิ้นสุด ถ้า await จะทำให้ Nest boot ค้างรอ Kafka
    void this.startConnectLoop();
  }

  async onModuleDestroy() {
    this.shuttingDown = true;
    this.wakeUp?.(); // ไม่ต้องรอ backoff ที่ค้างอยู่ให้ครบ 60 วิ
    await this.loopDone;
    try {
      await this.consumer.disconnect();
    } catch {
      // ปิดตอนยังไม่เคยต่อติด — ไม่ใช่เรื่องต้องรายงาน
    }
  }

  getHealth(): KafkaConsumerHealth {
    return {
      connected: this.connected,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt?.toISOString() ?? null,
      reconnectAttempts: this.attempts,
    };
  }

  /** exponential backoff: 1s 2s 4s 8s 16s 32s แล้วตันที่ 60s */
  private backoffMs(attempt: number): number {
    return Math.min(this.backoffBaseMs * 2 ** (attempt - 1), this.backoffMaxMs);
  }

  private startConnectLoop(): Promise<void> {
    if (this.looping || this.shuttingDown) return this.loopDone;
    this.looping = true;
    this.loopDone = this.connectLoop().finally(() => {
      this.looping = false;
    });
    return this.loopDone;
  }

  private async connectLoop(): Promise<void> {
    this.attempts = 0;

    while (!this.shuttingDown) {
      // เก็บเลขครั้งไว้ก่อน: GROUP_JOIN อาจยิงระหว่าง start() แล้ว reset this.attempts
      // ทำให้ log ออกมาเป็น "attempt 0" ถ้าไปอ่านตอนหลัง
      const attempt = ++this.attempts;
      try {
        await this.start();

        this.connected = true;
        this.lastError = null;
        this.lastConnectedAt = new Date();
        this.logger.log(
          `Kafka consumer connected (alerts.raw, alerts.cde) — attempt ${attempt}`,
        );
        this.attempts = 0;
        return;
      } catch (err) {
        this.connected = false;
        this.lastError = err instanceof Error ? err.message : String(err);

        // ปล่อย socket ค้างทิ้งก่อนลองใหม่ กันสถานะครึ่ง ๆ กลาง ๆ ตอน connect ผ่านแต่ subscribe ล้ม
        try {
          await this.consumer.disconnect();
        } catch {
          /* ไม่สำคัญ — กำลังจะต่อใหม่อยู่แล้ว */
        }

        if (this.shuttingDown) return;

        const delay = this.backoffMs(attempt);
        // log ทุกครั้ง ไม่ใช่เฉพาะครั้งสุดท้าย — ต้องเห็นได้ว่ายังพยายามอยู่ ไม่ได้ตายไปแล้ว
        this.logger.warn(
          `Kafka consumer connect failed (attempt ${attempt}): ${this.lastError} — ` +
            `ลองใหม่ใน ${Math.round(delay / 1000)}s (ไม่ยอมแพ้)`,
        );
        await this.sleep(delay);
      }
    }
  }

  private async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: ['alerts.raw', 'alerts.cde'],
      fromBeginning: false, // เริ่มจาก message ใหม่ ไม่ replay เก่า
    });
    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        await this.handleAlert(topic, message.value?.toString());
      },
    });
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

  private async handleAlert(topic: string, raw: string | undefined) {
    if (!raw) return;

    try {
      const alert = JSON.parse(raw);

      // map Python consumer's alert format → Alert entity DTO
      await this.alertsService.createOrDedup({
        logId: alert.log_id ?? null,
        alertType: alert.alert_type ?? 'UNKNOWN',
        severity: alert.severity ?? 'WARNING',
        source: alert.source ?? 'unknown',
        title: alert.title ?? 'Alert',
        detail: alert.detail ?? {},
      });

      this.logger.debug(
        `Persisted alert from ${topic}: ${alert.alert_type} / ${alert.source}`,
      );
    } catch (err: any) {
      // message เสีย/parse ไม่ได้ — log แต่ไม่ throw (ไม่ให้ consumer ตาย)
      this.logger.error(
        `Failed to persist alert from ${topic}: ${err.message}`,
      );
    }
  }
}
