import { Controller, Get, Patch, Param, Body, Post, UseGuards } from '@nestjs/common';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from 'src/auth/guards/roles.guard';

@UseGuards(AuthGuard('jwt'), RolesGuard)
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
