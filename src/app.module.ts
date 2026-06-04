import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LogsModule } from './logs/logs.module';
import { AlertsModule } from './alerts/alerts.module';
import { AuthModule } from './auth/auth.module';
import { KafkaModule } from './kafka/kafka.module';
import { VaultModule } from './vault/vault.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { RetentionModule } from './retention/retention.module';
import { ErasureModule } from './erasure/erasure.module';

@Module({
  imports: [
    LogsModule,
    AlertsModule,
    AuthModule,
    KafkaModule,
    VaultModule,
    MetricsModule,
    AuditModule,
    RetentionModule,
    ErasureModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}