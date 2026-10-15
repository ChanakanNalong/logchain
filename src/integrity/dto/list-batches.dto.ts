import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ListBatchesDto {
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  /** คั่นด้วย , ได้หลายค่า (OR) เช่น CONFIRMED,TAMPERED */
  @ApiPropertyOptional({ example: 'CONFIRMED,TAMPERED' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  status?: string;
}
