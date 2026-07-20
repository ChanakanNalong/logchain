import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
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
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      username: process.env.DB_USER ?? 'logchain',
      password: process.env.DB_PASS ?? 'logchain123',
      database: process.env.DB_NAME ?? 'logchain',
      autoLoadEntities: true,
      synchronize: true,
    }),
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
