import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ErasureService } from './erasure.service';
import { ErasureController } from './erasure.controller';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from './entities/erasure-log.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditAccess, ErasureLog]),
    AuthModule, // RolesGuard + JwtStrategy
  ],
  controllers: [ErasureController],
  providers: [ErasureService],
})
export class ErasureModule {}
