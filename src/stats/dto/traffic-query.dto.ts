import { IsIn, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TRAFFIC_RANGES } from '../traffic-ranges';
import type { TrafficRange } from '../traffic-ranges';

export class TrafficQueryDto {
  @ApiPropertyOptional({ enum: TRAFFIC_RANGES, default: '24h' })
  @IsOptional()
  @IsIn(TRAFFIC_RANGES)
  range?: TrafficRange = '24h';
}
