import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ListBatchesDto } from './dto/list-batches.dto';
import { BatchDiffService } from './batch-diff.service';

@ApiTags('integrity')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('batches')
export class BatchesController {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly diffService: BatchDiffService,
  ) {}

  /**
   * GET /api/v1/batches?limit=10&offset=0&status=CONFIRMED,TAMPERED
   * batch ล่าสุดพร้อมสถานะ anchor — หน้า Verify ใช้แสดงว่ามีอะไรให้ตรวจบ้าง
   * โดยไม่ต้องรู้ log id มาก่อน · สัญญา JSON: docs/api/batches-diff.md ข้อ 1
   */
  @Get()
  @Roles('analyst', 'operator', 'auditor', 'admin')
  @ApiOperation({ summary: 'List sealed batches (paged, filter by status)' })
  listBatches(@Query() query: ListBatchesDto) {
    return this.integrity.listBatches(query);
  }

  /**
   * GET /api/v1/batches/:id/diff — log ตำแหน่งไหนถูกแก้ / ลบ / แทรก เทียบกับ snapshot ตอน seal
   * admin + auditor (ผู้ตรวจ) · ทุกคำขอลง audit_access · สัญญา JSON: docs/api/batches-diff.md ข้อ 2
   */
  @Get(':id/diff')
  @Roles('admin', 'auditor')
  @ApiOperation({
    summary:
      'Per-position tamper diff of a batch against its seal-time snapshot',
  })
  diff(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException('Batch ID must be a UUID'),
      }),
    )
    id: string,
  ) {
    return this.diffService.diff(id);
  }
}
