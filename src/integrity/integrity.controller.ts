import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';

@ApiTags('integrity')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('logs')
export class IntegrityController {
  constructor(private readonly integrity: IntegrityService) {}

  /**
   *  POST /api/v1/logs/verify-now
   *  สั่ง re-anchor + verify ทันที (ปกติ cron ทำทุก 1 นาที)
   */

  @Post('verify-now')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Trigger integrity verification immediately' })
  async verifyNow() {
    await this.integrity.reanchorUnverified();
    await this.integrity.verifyAllBatches();
    return { ok: true, verifiedAt: new Date().toISOString() };
  }

  /**
   *  POST /api/v1/logs/seal-now
   *  สั่ง seal batch ทันที (ปกติ cron ทำทุก 30 นาที) - ใช้ตอน demo
   */

  @Post('seal-now')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Seal a batch of pending logs immediately' })
  async sealNow() {
    const batch = await this.integrity.sealBatch();
    if (!batch) {
      return { message: 'No pending logs to seal' };
    }
    return batch;
  }

  /**
   * GET /api/v1/logs/:id/proof
   * คืน Merkle proof ของ log ตัวเดียว - พิสูจน์ว่า log อยู่ใน chain จริง
   *
   * ต้อง validate UUID ที่ param ก่อน: log_batch_mapping.log_id เป็น type uuid
   * ถ้าปล่อย id ที่ไม่ใช่ UUID (เช่น 8 ตัวแรกที่ตาราง Logs โชว์) ลงไปถึง query
   * Postgres จะโยน "invalid input syntax for type uuid" -> กลายเป็น 500 ทั้งที่
   * เป็นความผิดของ input -> หน้า Verify ขึ้น "Verification failed" ซึ่งชี้ผิดทาง
   */
  @Get(':id/proof')
  @Roles('analyst', 'operator', 'admin')
  @ApiOperation({ summary: 'Get Merkle proof for a single log' })
  async getProof(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () =>
          new BadRequestException(
            'Log ID must be a full UUID — the log table shows only the first 8 characters, click an ID there to copy the whole one',
          ),
      }),
    )
    id: string,
  ) {
    const result = await this.integrity.getProofForLog(id);
    if (!result) {
      throw new NotFoundException('Log not found or not yet sealed in a batch');
    }

    return {
      logId: result.log.id,
      rawHash: result.log.rawHash,
      batch: {
        id: result.batch.id,
        merkleRoot: result.batch.merkleRoot,
        txHash: result.batch.txHash,
        blockNumber: result.batch.blockNumber,
        status: result.batch.status,
      },
      proof: result.proof,
      verify: result.verified, // true = proof ถูกต้อง log อยู่ใน tree จริง
    };
  }
}
