import {
    Controller, Post, Get, Param, Body, Query,
    UseGuards, HttpCode, HttpStatus,
    ParseIntPipe, DefaultValuePipe
} from "@nestjs/common";
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from '@nestjs/throttler';
import { LogService } from "./logs.service";
import { CreateLogDto } from "./dto/create-log.dto";
import { RolesGuard, Roles } from '../auth/guards/roles.guard';

@ApiTags('logs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('api/v1/logs')
export class LogController {
    constructor(private readonly logsService: LogService) { }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @Roles('ingestor', 'admin')
    @Throttle({ default: { limit: 500, ttl: 60_000 } })
    @ApiOperation({ summary: 'Ingest log (mask -> hash order enforced)' })
    create(@Body() dto: CreateLogDto) {
        return this.logsService.ingest(dto);
    }

    @Get()
    @Roles('analyst', 'operator', 'admin')
    findAll(
        @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
    ) {
        return this.logsService.findRecent(limit);
    }

    @Get(':id')
    @Roles('analyst', 'operator', 'admin')
    @ApiOperation({ summary: 'Get log by ID' })
    findOne(@Param('id') id: string) {
        return this.logsService.findOne(id);
    }
}
