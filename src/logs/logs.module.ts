import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Log } from './entities/log.entity';
import { LogService } from './logs.service';
import { LogsController } from './logs.controller';
import { LogDetailService } from './log-detail.service';
import { PiiMaskingService } from './services/pii-masking.service';
import { KafkaModule } from '../kafka/kafka.module';
import { MetricsModule } from '../metrics/metrics.module';
import { IntegrityModule } from '../integrity/integrity.module';
import { BlockchainModule } from '../blockchain/blockchain.module';
import { AlertsModule } from '../alerts/alerts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Log]),
    KafkaModule,
    MetricsModule,
    // GET /logs/:id/detail: proof (integrity) + root บน chain + alert ที่อ้างถึง
    IntegrityModule,
    BlockchainModule,
    AlertsModule,
  ],
  controllers: [LogsController],
  providers: [LogService, PiiMaskingService, LogDetailService],
  exports: [LogService],
})
export class LogsModule {}
