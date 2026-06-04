import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ErasureService } from './erasure.service';
import { ErasureController } from './erasure.controller';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { Alert } from '../alerts/entities/alert.entity';

@Module({
  imports: [TypeOrmModule.forFeature([AuditAccess, Alert])],
  controllers: [ErasureController],
  providers: [ErasureService],
})
export class ErasureModule {}