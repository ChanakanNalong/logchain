import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const LIST_LOGS_MAX_LIMIT = 1000;

/** GET /api/v1/logs — สัญญาเต็มอยู่ใน docs/api/logs-alerts.md ข้อ 1 */
export class ListLogsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIST_LOGS_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  /** คั่นด้วย , ได้หลายค่า (OR) */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  severity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  eventType?: string;

  /** ค้นใน message (ILIKE) */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
