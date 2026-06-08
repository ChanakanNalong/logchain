import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditAccess } from './entities/audit-access.entity';
import { AuditService } from './audit.service';

@Module({
    imports: [TypeOrmModule.forFeature([AuditAccess])],
    providers: [AuditService],
    exports: [AuditService],
})
export class AuditModule {}
