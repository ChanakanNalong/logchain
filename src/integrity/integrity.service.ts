import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Log } from '../logs/entities/log.entity'
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { MerkleService } from './service/merkle.service';
import { BlockchainService } from '../blockchain/blockchain.service';

const BATCH_SIZE = 100; // กำหนดขนาด batch

@Injectable()
export class IntegrityService {
    private readonly logger = new Logger(IntegrityService.name);

    constructor(
        @InjectRepository(Log)              private readonly logsRepo:      Repository<Log>,
        @InjectRepository(Batch)            private readonly batchesRepo:   Repository<Batch>,
        @InjectRepository(Alert)            private readonly alertsRepo:    Repository<Alert>,
        @InjectRepository(LogBatchMapping)  private readonly mappingRepo:   Repository<LogBatchMapping>,
        private readonly merkle: MerkleService,
        private readonly blockchain: BlockchainService,
    ) {}

    /**
   * Seal batch — รวม logs ที่ยังไม่ถูก map เข้า batch
   */
  async sealBatch(): Promise<Batch | null> {
    if (!this.blockchain.ready) {
        this.logger.warn('Blockchain not ready - skip sealing');
        return null;
    }

     // 1. หา log_id ที่ถูก map แล้ว (เพื่อ exclude)
     const mapped = await this.mappingRepo.find({ select: { logId: true } });
     const mappedIds = mapped.map(m => m.logId);

     // 2. logs ที่ยังไม่ถูก map (batch ใหม่)
     const pendingLogs = await this.logsRepo.find({
        where: mappedIds.length > 0 ? { id: Not(In(mappedIds))} : {},
        order: { createdAt: 'ASC' },
        take: BATCH_SIZE
     });

     if (pendingLogs.length === 0) {
        this.logger.debug('No pending logs to seal');
        return null;
     }

     // 3. สร้าง Merkle tree
     const leaves = pendingLogs.map(log => log.rawHash);
     const { root } = this.merkle.buildTree(leaves);

     // 4. สร้าง batch (PENDING)
     const batch = await this.batchesRepo.save(this.batchesRepo.create({
        merkleRoot: root.replace('0x', ''),
        logCount: pendingLogs.length,
        status: 'PENDING',
     }));

     try {
        // 5. commit root ขึ้น chain
        const { txHash, blockNumber } = await this.blockchain.storeRoot(batch.id, root);

        batch.txHash = txHash;
        batch.blockNumber = blockNumber;
        batch.status = 'CONFIRMED';
        batch.confirmedAt = new Date();
        await this.batchesRepo.save(batch);

        // 6. INSERT mapping (ไม่ใช่ UPDATE logs - logs ยัง imutable)
        const mappings = pendingLogs.map(log =>
            this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
        );
        await this.mappingRepo.save(mappings);

        this.logger.log(`Batch ${batch.id} sealed: ${pendingLogs.length} log, root=${root.slice(0, 18)}...`);
        return batch;
    }   catch (err) {
        batch.status = 'FAILED';
        await this.batchesRepo.save(batch);
        this.logger.error(`Batch ${batch.id} failed to commit`, err);
        return batch;
        }
    }

    /**
   * Verify ทุก batch ที่ CONFIRMED
   */
  async verifyAllBatches(): Promise<void> {
    if (!this.blockchain.ready) return;

    const confirmed = await this.batchesRepo.find({ where: { status: 'CONFIRMED'}});

    for (const batch of confirmed) {
        const leaves = await this.getLeavesForBatch(batch.id);
        const { root } = this.merkle.buildTree(leaves);
        const isValid = await this.blockchain.verifyRoot(batch.id, root);

        if (!isValid) {
            await this.raiseTamperAlert(batch);
            batch.status = 'TAMPERED';
            await this.batchesRepo.save(batch);
        }
    }
  }

  /**
   * helper — ดึง rawHash ของ logs ใน batch (เรียงตามลำดับเดิม)
   */
  private async getLeavesForBatch(batchId: string): Promise<string[]> {
    const mappings = await this.mappingRepo.find({
        where: { batchId },
        order: { mappedAt: 'ASC' },
    });
    const logIds = mappings.map(m => m.logId);
    const logs = await this.logsRepo.find({ where: { id: In(logIds) } });
    // เรียง logs ตามลำดับ logIds เพื่อให้ Merkle tree เหมือนตอน seal
    const logMap = new Map(logs.map(l => [l.id, l.rawHash]));
    return logIds.map(id => logMap.get(id)!);
  }

  private async raiseTamperAlert(batch: Batch): Promise<void> {
    const existing = await this.alertsRepo.findOne({
        where: { batchId: batch.id, alertType: 'INTEGRITY_TAMPERED' },
    });
    if (existing) return;

    await this.alertsRepo.save(this.alertsRepo.create({
        batchId: batch.id,
        alertType: 'INTEGRITY_TAMPERED',
        severity: 'CRITICAL',
        source: 'INTEGRITY',
        title: `Batch ${batch.id} integrity violation detected`,
        detail: {
            batchId: batch.id,
            merkleRoot: batch.merkleRoot,
            txHash: batch.txHash,
            message: 'On-chain root does not match recomputed root',
        },
        status: 'OPEN',
    }));

    this.logger.error(`TAMPER DETECTED on batch ${batch.id}`);
  }

  /**
   * สร้าง Merkle proof สำหรับ log ตัวเดียว
   */
  async getProofForLog(logId: string) {
    // หา batch ของ log นี้จาก mapping
    const mapping = await this.mappingRepo.findOneBy({ logId });
    if (!mapping) return null; // log ยังไม่ถูก seal

    const log = await this.logsRepo.findOneBy({ id: mapping.logId });
    const batch = await this.batchesRepo.findOneBy({ id: mapping.batchId });
    if (!log || !batch) return null;

    const leaves = await this.getLeavesForBatch(batch.id);
    const proof = this.merkle.getProof(leaves, log.rawHash);
    const verified = this.merkle.verifyProof(log.rawHash, proof, '0x' + batch.merkleRoot);

    return { log, batch, proof, verified };
  }
}
