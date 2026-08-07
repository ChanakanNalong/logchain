import { Module } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [AlertsModule],  // KafkaConsumerService ใช้ AlertsService
  providers: [KafkaProducerService, KafkaConsumerService],
  exports: [KafkaProducerService],
})
export class KafkaModule {}
