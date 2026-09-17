import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { Alert } from './entities/alert.entity';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';

@ApiTags('alerts')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  /**
   * ทุก endpoint ต้องมี @Roles เสมอ — RolesGuard ปล่อยผ่านเมื่อไม่มี metadata
   * (roles.guard.ts: `if (!required?.length) return true`) ตอนที่ไม่มีบรรทัดนี้
   * token ไหนก็ได้ที่ auth ผ่าน รวมถึง service account ที่ไม่มี role เลย
   * สามารถยัด alert ปลอมหรือปิด tamper alert ทิ้งได้เงียบๆ
   */
  @Post()
  @Roles('operator', 'admin')
  @ApiOperation({
    summary: 'Raise an alert (deduped while an identical one is OPEN)',
  })
  create(@Body() dto: Partial<Alert>) {
    return this.alertsService.createOrDedup(dto);
  }

  @Get()
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'List every alert, newest first' })
  findAll() {
    return this.alertsService.findAll();
  }

  /** ปิด alert = การกระทำเชิง triage ไม่ใช่การอ่าน — analyst จึงไม่อยู่ในลิสต์ */
  @Patch(':id/resolve')
  @Roles('operator', 'admin')
  @ApiOperation({ summary: 'Mark an alert as RESOLVED' })
  resolve(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException('Alert ID must be a UUID'),
      }),
    )
    id: string,
  ) {
    return this.alertsService.resolve(id);
  }
}
