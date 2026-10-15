import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LogService } from './logs.service';
import { CreateLogDto } from './dto/create-log.dto';
import { ListLogsQuery } from './dto/list-logs.query';
import { LogDetailService } from './log-detail.service';

/** id ต้องเป็น UUID เต็ม — ไม่งั้น Postgres โยน invalid input syntax เป็น 500 */
const logIdPipe = () =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException('Log ID must be a full UUID'),
  });
import { RolesGuard, Roles } from '../auth/guards/roles.guard';

@ApiTags('logs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('logs')
export class LogsController {
  constructor(
    private readonly logsService: LogService,
    private readonly logDetail: LogDetailService,
  ) {}

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
  @ApiOperation({
    summary: 'Paged, filtered logs with the on-chain status of their batch',
  })
  findAll(@Query() query: ListLogsQuery) {
    return this.logsService.list(query);
  }

  @Get(':id')
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'Get log by ID' })
  findOne(@Param('id', logIdPipe()) id: string) {
    return this.logsService.findOne(id);
  }

  /** auditor อ่านได้ — หลักฐานของ log ตัวเดียวคือสิ่งที่ผู้ตรวจต้องดู (ทุกคำขอลง audit_access) */
  @Get(':id/detail')
  @Roles('analyst', 'operator', 'admin', 'auditor')
  @ApiOperation({
    summary:
      'Log + batch + Merkle proof + linked alerts + live on-chain root check',
  })
  detail(@Param('id', logIdPipe()) id: string) {
    return this.logDetail.getDetail(id);
  }
}
