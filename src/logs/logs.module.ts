import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Log } from './entities/log.entity';
import { LogService } from './logs.service';
import { LogController } from './logs.controller';
import { PiiMaskingService } from './services/pii-masking.service';
import { KafkaModule } from '../kafka/kafka.module';
import { MetricsModule } from '../metrics/metrics.module';

@Module({
    imports: [
        TypeOrmModule.forFeature([Log]),
        KafkaModule,
        MetricsModule,
    ],
    controllers: [LogController],
    providers: [LogService, PiiMaskingService],
    exports: [LogService],
})
export class LogsModule {}
