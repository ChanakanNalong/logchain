import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
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

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer: Producer;
  private isConnected = false;

  constructor(cfg: ConfigService) {
    const kafka = new Kafka({
      clientId: 'api-gateway',
      brokers: cfg.get<string>('KAFKA_BROKERS', 'kafka-1:9092').split(','),
      ...buildKafkaSsl(cfg),
      retry: { retries: 1, 
      initialRetryTime: 100 },
      logLevel: 1,
    });
    this.producer = kafka.producer({ idempotent: true });
  }

  async onModuleInit(){    
    try { 
      await this.producer.connect(); 
      this.isConnected = true;
      this.logger.log('Kafka connected'); 
    } catch (err) {
      // ตอน dev ยังไม่มี Kafka - ไม่ให้ app ค้าง
      this.logger.warn('Kafka not available (dev mode) - log publishing disabled', err);
    }
  }
  async onModuleDestroy() {
    if (this.isConnected) {
      await this.producer.disconnect();
    }
  }

  async publishLog(event: LogEvent): Promise<void> {
    // ข้ามถ้า producer ยังไม่ connect (dev mode ไม่มี Kafka)
    // producer ถูกสร้างใน constructor เสมอ จึงต้องเช็ค isConnected ไม่ใช่ตัว producer
    if (!this.isConnected) return;

    try {
      await this.producer.send({
        topic: 'logs.raw',
        compression: CompressionTypes.GZIP,
        messages: [{
          key: event.source,
          value: JSON.stringify(event),
          headers: { severity: event.severity, cde: String(event.cdeScope) },
        }],
      });
    } catch (err) {
      // DLQ fallback — log ที่ส่งไม่สำเร็จต้องไม่หายเงียบ
      this.logger.error(`Kafka publish failed, routing to DLQ: ${(err as Error).message}`);
      try {
        await this.producer.send({
          topic: 'logs.raw.dlq',
          messages: [{
            key: event.source,
            value: JSON.stringify(event),
            headers: {
              'original-topic': 'logs.raw',
              error: (err as Error).message,
              'failed-at': new Date().toISOString(),
            },
          }],
        });
        this.logger.warn(`Log ${event.id} routed to DLQ`);
      } catch (dlqErr) {
        this.logger.error(`CRITICAL: DLQ also failed for ${event.id}`, dlqErr);
      }
    }
  }
}