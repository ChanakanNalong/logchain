import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ListBatchesDto } from './dto/list-batches.dto';

@ApiTags('integrity')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('batches')
export class BatchesController {
  constructor(private readonly integrity: IntegrityService) {}

  /**
   * GET /api/v1/batches?limit=10
   * batch ล่าสุดพร้อมสถานะ anchor — หน้า Verify ใช้แสดงว่ามีอะไรให้ตรวจบ้าง
   * โดยไม่ต้องรู้ log id มาก่อน
   */
  @Get()
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'List the most recently sealed batches' })
  listBatches(@Query() query: ListBatchesDto) {
    return this.integrity.listBatches(query.limit ?? 10);
  }
}
