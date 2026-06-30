import { IsString, IsNotEmpty, IsIn, IsOptional, IsBoolean, MaxLength, IsIP, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// DTO - กำหนดรูปแบบและ validation ของ request body
// class-validator จะ throw error อัจโนมัติถ้า input ไม่ตรง

export class CreateLogDto {
    @ApiProperty({ example: 'web-server-01' })
    @IsString() @IsNotEmpty() @MaxLength(128)
    source: string;

    @ApiPropertyOptional({ example: '10.0.0.1' })
    @IsOptional() @IsIP()
    sourceIp?: string;

    @ApiProperty({ example: 'AUTH_FAILURE' })
    @IsString() @IsNotEmpty() @MaxLength(64)
    eventType: string;

    @ApiProperty({ enum: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'], default: 'INFO' })
    @IsIn(['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'])
    severity: string = 'INFO';

    @ApiProperty({ example: 'Failed login from admin panel' })
    @IsString() @IsNotEmpty() @MaxLength(10_000)
    message: string;
    
    @ApiProperty({ enum: ['CONFIDENTIAL', 'INTERNAL', 'PUBLIC'], default: 'INTERNAL' })
    @IsIn(['CONFIDENTIAL', 'INTERNAL', 'PUBLIC'])
    classification: string = 'INTERNAL';

    // cdeScope - true ถ้า log มาจาก Cardholder Data Environment (PCI)
    @ApiPropertyOptional({ default: false })
    @IsOptional() @IsBoolean()
    cdeScope?: boolean = false;

    @ApiPropertyOptional({ default: 365, description: 'จำนวนวันที่เก็บ log (PDPA)' })
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650)
    retentionDays?: number = 365;
}
