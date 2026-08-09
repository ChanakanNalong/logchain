import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { StatsService } from './stats.service';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /** GET /api/v1/stats/overview — ตัวเลขรวมสำหรับหน้า Dashboard */
  @Get('overview')
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'Dashboard overview counters, 24h traffic and top source IPs' })
  getOverview() {
    return this.statsService.getOverview();
  }
}
