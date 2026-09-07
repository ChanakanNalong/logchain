import { Controller, Get } from '@nestjs/common';
import { KafkaConsumerService } from '../kafka/kafka-consumer.service';

@Controller('health')
export class HealthController {
  constructor(private readonly kafkaConsumer: KafkaConsumerService) {}

  /**
   * liveness ของ process — คืน 200 เสมอตราบใดที่แอปยังตอบได้
   * ตั้งใจไม่ทำให้ Kafka ที่หลุดมาทำให้ /health เป็น 5xx เพราะ ingest (producer path)
   * ยังทำงานได้ปกติ และ demo-preflight.sh ใช้เช็คว่า backend ขึ้นหรือยังอยู่
   *
   * สถานะ consumer อยู่ใน kafkaConsumer.connected — ให้ผู้เรียกตัดสินใจเอง
   * (demo-preflight.sh gate ที่ field นี้)
   */
  @Get()
  check() {
    return {
      status: 'ok',
      kafkaConsumer: this.kafkaConsumer.getHealth(),
    };
  }
}
