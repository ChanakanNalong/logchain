import { Controller, Get, Param,UseGuards, NotFoundException, Post, HttpCode } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IntegrityService } from "./integrity.service";
import { RolesGuard, Roles } from "../auth/guards/roles.guard";

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
     * GET /api/v1/logs/:id/proof
     * คืน Merkle proof ของ log ตัวเดียว - พิสูจน์ว่า log อยู่ใน chain จริง
     */
    @Get(':id/proof')
    @Roles('analyst', 'operator', 'admin')
    @ApiOperation({ summary: 'Get Merkle proof for a single log' })
    async getProof(@Param('id') id: string) {
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