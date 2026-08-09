// src/compliance/compliance.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ComplianceService } from './compliance.service';

@Controller('compliance')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Get('reports')
  @Roles('admin', 'auditor')
  getReports(@Query('from') from?: string, @Query('to') to?: string) {
    return this.complianceService.getReports(from, to);
  }
}