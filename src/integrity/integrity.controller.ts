import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IntegrityService } from './integrity.service';
import { SealSkippedError } from './seal-config';
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
   *  สั่ง seal batch ทันที (ปกติ cron ทำทุก 1 นาที) - ใช้ตอน demo
   */

  @Post('seal-now')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Seal a batch of pending logs immediately' })
  async sealNow() {
    // seal-now ปิด batch เดียวเหมือนเดิม และไม่ติด backoff ของ cron (admin สั่งเองตั้งใจ)
    // แต่ยังติด guard ยอดเงิน — 503 พร้อมเหตุผล ไม่ใช่ "No pending logs" ที่ชี้ผิดทาง
    let batch;
    try {
      batch = await this.integrity.sealBatch('manual');
    } catch (err) {
      if (err instanceof SealSkippedError) {
        throw new ServiceUnavailableException(err.message);
      }
      throw err;
    }
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
      // raw_hash ที่เก็บไว้ใน DB vs hash ที่คำนวณใหม่จากเนื้อหาปัจจุบัน — ต่างกัน = ถูกแก้
      rawHash: result.storedRawHash,
      contentHash: result.contentHash,
      // INTACT = เนื้อหา + raw_hash ตรงเดิม · CONTENT_MODIFIED = เนื้อ log ถูกแก้ ·
      // HASH_MODIFIED = คอลัมน์ raw_hash ถูกแก้ (เนื้อหาเดิม) · UNKNOWN = legacy ไม่มี snapshot
      integrity: result.integrity,
      // 0-based ตำแหน่ง leaf · leafHash = sha256(content hash) — docs/api/merkle-tree.md ข้อ 2
      leafIndex: result.leafIndex,
      leafHash: result.leafHash,
      batch: {
        id: result.batch.id,
        merkleRoot: result.batch.merkleRoot,
        txHash: result.batch.txHash,
        blockNumber: result.batch.blockNumber,
        status: result.batch.status,
      },
      proof: result.proof,
      verify: result.verified, // true = เนื้อหาปัจจุบันของ log อยู่ใน tree ที่ anchor จริง
    };
  }
}
