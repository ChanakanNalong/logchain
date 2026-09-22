import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VaultService } from './vault/vault.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule } from '@nestjs/terminus';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuthModule } from './auth/auth.module';
import { LogsModule } from './logs/logs.module';
import { AlertsModule } from './alerts/alerts.module';
import { NotificationModule } from './notification/notification.module';
import { RetentionModule } from './retention/retention.module';
import { ErasureModule } from './erasure/erasure.module';
import { KafkaModule } from './kafka/kafka.module';
import { VaultModule } from './vault/vault.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuditModule } from './audit/audit.module';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { HealthController } from './health/health.controller';
import { BlockchainModule } from './blockchain/blockchain.module';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ScheduleModule } from '@nestjs/schedule';
import { IntegrityModule } from './integrity/integrity.module';
import { ComplianceModule } from './compliance/compliance.module';
import { StatsModule } from './stats/stats.module';
import { AdminModule } from './admin/admin.module';
import { AlertsRuleDedup1790121600000 } from './database/migrations/1790121600000-AlertsRuleDedup';
import { AlertsLastNotified1790208000000 } from './database/migrations/1790208000000-AlertsLastNotified';

@Module({
  imports: [
    // ConfigModule.forRoot({ isGlobal: true }) -> โหลด .env และ inject ได้ทุก module
    ConfigModule.forRoot({ isGlobal: true }),

    VaultModule, // ต้องมาก่อน TypeOrmModule

    // Rate limiting global - 200 req/นาที ต่อ IP
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 200 }]),

    // TypeORM - เชื่อ PostgreSQL, synchronize: false ใช้ migration แทน
    TypeOrmModule.forRootAsync({
      inject: [VaultService],
      useFactory: async (vault: VaultService) => {
        await vault.init();
        const secrets = vault.get();
        return {
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5433'),
          username: 'logchain',
          password: secrets.database.password,
          database: 'logchain',
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          synchronize: false,
          // import class ตรง ๆ ไม่ใช้ glob — ไม่ต้องเดา path ของ dist ตอน build
          // รันตอน boot ทุกครั้ง migration ที่รันไปแล้วถูกข้าม (จดไว้ในตาราง migrations)
          migrations: [
            AlertsRuleDedup1790121600000,
            AlertsLastNotified1790208000000,
          ],
          migrationsRun: true,
        };
      },
    }),

    TerminusModule,
    VaultModule,
    AuthModule,
    KafkaModule,
    AuditModule,
    LogsModule,
    AlertsModule,
    NotificationModule,
    RetentionModule,
    ErasureModule,
    MetricsModule,
    BlockchainModule,
    ScheduleModule.forRoot(),
    IntegrityModule,
    ComplianceModule,
    StatsModule,
    AdminModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // APP_INTERCEPTOR -> register AuditInterceptor แบบ global
    // ทุก request จะถูก intercept โดยอัตโนมัติ ไม่ต้อง @UseInterceptors ทุก controller
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
