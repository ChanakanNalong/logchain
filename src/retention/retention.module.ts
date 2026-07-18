import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RetentionService } from './retention.service';
import { Alert } from '../alerts/entities/alert.entity';
import { AuditAccess } from '../audit/entities/audit-access.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Alert, AuditAccess]),
  ],
  providers: [RetentionService],
})
export class RetentionModule {}
