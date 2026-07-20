import { Controller, Get, Patch, Param, Body, Post, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { RolesGuard, Roles } from '../auth/roles.guard';

@Controller('alerts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Post()
  @Roles('admin', 'analyst')
  create(@Body() dto: Partial<Alert>) {
    return this.alertsService.createOrDedup(dto);
  }

  @Get()
  @Roles('admin', 'analyst', 'auditor')
  findAll() {
    return this.alertsService.findAll();
  }

  @Patch(':id/resolve')
  @Roles('admin', 'analyst')
  resolve(@Param('id') id: string) {
    return this.alertsService.resolve(id);
  }
}
