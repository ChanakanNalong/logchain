import { Controller, Get, Patch, Param, Body, Post } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Post()
  create(@Body() dto: Partial<Alert>) {
    return this.alertsService.createOrDedup(dto);
  }

  @Get()
  findAll() {
    return this.alertsService.findAll();
  }

  @Patch(':id/resolve')
  resolve(@Param('id') id: string) {
    return this.alertsService.resolve(id);
  }
}
