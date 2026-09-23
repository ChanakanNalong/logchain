import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PendingLog } from './entities/pending-log.entity';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  // PendingLog = outbox ของ log ที่ยังส่งขึ้น Kafka ไม่ได้ (KafkaProducerService)
  imports: [AlertsModule, TypeOrmModule.forFeature([PendingLog])],
  providers: [KafkaProducerService, KafkaConsumerService],
  // export KafkaConsumerService ให้ HealthController อ่านสถานะ connection ได้
  exports: [KafkaProducerService, KafkaConsumerService],
})
export class KafkaModule {}
