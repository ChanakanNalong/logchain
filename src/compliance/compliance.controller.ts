import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ComplianceService } from './compliance.service';

@Controller('compliance')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get('reports')
  @Roles('admin', 'auditor')
  getReports() {
    return this.complianceService.getReports();
  }
}
