import { Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule], // KafkaConsumerService ใช้ AlertsService
  providers: [KafkaProducerService, KafkaConsumerService],
  // export KafkaConsumerService ให้ HealthController อ่านสถานะ connection ได้
  exports: [KafkaProducerService, KafkaConsumerService],
})
export class KafkaModule {}
