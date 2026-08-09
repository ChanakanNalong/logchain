import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AdminController } from './admin.controller';
import { KeycloakAdminService } from './keycloak-admin.service';

// VaultService มาจาก VaultModule ที่เป็น @Global แล้ว
@Module({
  imports: [AuditModule],
  controllers: [AdminController],
  providers: [KeycloakAdminService],
  exports: [KeycloakAdminService],
})
export class AdminModule {}
