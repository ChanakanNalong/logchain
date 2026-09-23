import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from '../erasure/entities/erasure-log.entity';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';

@Module({
  imports: [TypeOrmModule.forFeature([Batch, Log, AuditAccess, ErasureLog])],
  controllers: [ComplianceController],
  providers: [ComplianceService],
})
export class ComplianceModule {}
