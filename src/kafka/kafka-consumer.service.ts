import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer } from 'kafkajs';
import { buildKafkaSsl } from './kafka-ssl.config';
import { AlertsService } from '../alerts/alerts.service';

/**
 * Consume alerts จาก detection service (Python) ผ่าน Kafka
 * → เขียนเข้า DB ผ่าน AlertsService.createOrDedup (+ email ถ้า CRITICAL)
 *
 * Topics:
 *   alerts.raw  — non-CDE alerts
 *   alerts.cde  — CDE-scoped alerts (PCI cardholder data env)
 */
@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer: Consumer;
  private isConnected = false;

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
  }

  async onModuleInit() {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await this.consumer.connect();
        await this.consumer.subscribe({
          topics: ['alerts.raw', 'alerts.cde'],
          fromBeginning: false,  // เริ่มจาก message ใหม่ ไม่ replay เก่า
        });

        await this.consumer.run({
          eachMessage: async ({ topic, message }) => {
            await this.handleAlert(topic, message.value?.toString());
          },
        });

        this.isConnected = true;
        this.logger.log('Kafka consumer connected (alerts.raw, alerts.cde)');
        return;
      } catch (err: any) {
        // dev mode ไม่มี Kafka — ไม่ให้ app ค้าง
        this.logger.warn(
            `Kafka consumer connect failed (attempt ${attempt}/5): ${err.message}`,
          );
          if (attempt < 5) {
            await new Promise((r) => setTimeout(r, 3000 * attempt));
          }
        }
      }
      this.logger.error('Kafka consumer unavailable — alert persistence disabled');
  }

  async onModuleDestroy() {
    if (this.isConnected) {
      await this.consumer.disconnect();
    }
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

      this.logger.debug(`Persisted alert from ${topic}: ${alert.alert_type} / ${alert.source}`);
    } catch (err: any) {
      // message เสีย/parse ไม่ได้ — log แต่ไม่ throw (ไม่ให้ consumer ตาย)
      this.logger.error(`Failed to persist alert from ${topic}: ${err.message}`);
    }
  }
}
