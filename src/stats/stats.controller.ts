import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { StatsService } from './stats.service';
import { TrafficQueryDto } from './dto/traffic-query.dto';
import { DEFAULT_TRAFFIC_RANGE, TRAFFIC_RANGES } from './traffic-ranges';

@ApiTags('stats')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  /** GET /api/v1/stats/overview — ตัวเลขรวมสำหรับหน้า Dashboard */
  @Get('overview')
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({
    summary: 'Dashboard overview counters, 24h traffic and top source IPs',
  })
  getOverview() {
    return this.statsService.getOverview();
  }

  /**
   * GET /api/v1/stats/traffic?range=24h — ซีรีส์ log volume ตามช่วงเวลาที่กราฟเลือก
   * แยกจาก /overview เพื่อให้เปลี่ยนช่วงเวลาแล้วยิงแค่กราฟ ไม่ต้องนับ KPI ใหม่ทั้งหน้า
   */
  @Get('traffic')
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'Log volume series for the selected time range' })
  @ApiQuery({
    name: 'range',
    enum: TRAFFIC_RANGES,
    required: false,
    example: DEFAULT_TRAFFIC_RANGE,
  })
  getTraffic(@Query() query: TrafficQueryDto) {
    return this.statsService.getTraffic(query.range ?? DEFAULT_TRAFFIC_RANGE);
  }
}
