import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditAccess } from 'src/audit/entities/audit-access.entity';
import { AuditService } from 'src/audit/audit.service';


@Module({
    imports: [TypeOrmModule.forFeature([AuditAccess])],
    providers: [AuditService],
    exports: [AuditService],
})
export class AuthModule {}
