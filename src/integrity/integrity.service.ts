import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Log } from '../logs/entities/log.entity'
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { MerkleService } from './service/merkle.service';
import { BlockchainService, classifyChainError } from '../blockchain/blockchain.service';

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
        order: { createdAt: 'ASC', id: 'ASC' },   // ต้องตรงกับ getLeavesForBatch
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
        const { txHash, blockNumber, confirmed } = await this.blockchain.storeRoot(batch.id, root);

        batch.txHash = txHash;
        batch.blockNumber = blockNumber;

        // tx ส่งแล้วแต่รอ confirm ไม่ทัน (public RPC ช้า) — ไม่ใช่ FAILED และห้ามค้าง PENDING
        // ปล่อยเป็น UNVERIFIED ให้ verifyAllBatches ตามผลต่อ: tx ลงเมื่อไร -> MATCH -> CONFIRMED
        if (confirmed === false) return await this.deferConfirmation(batch, pendingLogs, root);

        return await this.confirmBatch(batch, pendingLogs, root);
    }   catch (err) {
        // "Root already exists" ไม่ใช่ความล้มเหลว — root ของ batch นี้ถูก anchor ไปแล้ว
        // (retry ซ้ำ / tx confirm ทีหลังแล้ว estimateGas ของรอบใหม่ revert)
        // บน Amoy chain state ไม่ reset เหมือน Hardhat จึงเจอเคสนี้ได้จริง
        if (classifyChainError(err) === 'ROOT_EXISTS') {
            return await this.adoptExistingRoot(batch, pendingLogs, root);
        }

        if (classifyChainError(err) === 'NOT_AUTHORIZED') {
            // wallet ที่เซ็นไม่ใช่ owner ของ contract — misconfig ระดับ deployment
            // ทุก batch หลังจากนี้จะพังเหมือนกันจนกว่าจะแก้ key/address
            this.logger.error(
                `Batch ${batch.id} rejected by contract: signer is not the contract owner. ` +
                    'ตรวจว่า BLOCKCHAIN_PRIVATE_KEY ใน Vault ตรงกับ owner ของ CONTRACT_ADDRESS',
            );
        }

        batch.status = 'FAILED';
        await this.batchesRepo.save(batch);
        this.logger.error(`Batch ${batch.id} failed to commit`, err);
        return batch;
        }
    }

  /**
   * ปิดงาน batch ที่ anchor สำเร็จ — ตั้ง CONFIRMED + ผูก mapping
   * (แยกออกมาเพราะทั้ง path ปกติและ path "root อยู่บน chain แล้ว" ใช้ร่วมกัน)
   */
  private async confirmBatch(batch: Batch, logs: Log[], root: string): Promise<Batch> {
    batch.status = 'CONFIRMED';
    batch.confirmedAt = new Date();
    await this.batchesRepo.save(batch);

    // INSERT mapping (ไม่ใช่ UPDATE logs - logs ยัง imutable)
    const mappings = logs.map(log =>
      this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
    );
    await this.mappingRepo.save(mappings);

    this.logger.log(`Batch ${batch.id} sealed: ${logs.length} log, root=${root.slice(0, 18)}...`);
    return batch;
  }

  /**
   * tx ขึ้น chain แล้วแต่ยังไม่ confirm ในเวลาที่รอ — ผูก mapping ไว้เหมือน batch ปกติ
   * แล้วตั้ง UNVERIFIED เพื่อให้ verifyAllBatches recompute root แล้วตามผลเอง
   *
   * ต้องเขียน mapping ด้วย ไม่งั้น getLeavesForBatch คืน [] แล้ว verify รอบถัดไป
   * จะคำนวณ root จาก leaf ว่าง = ไม่มีวันตรงกับที่ anchor ไว้
   */
  private async deferConfirmation(batch: Batch, logs: Log[], root: string): Promise<Batch> {
    batch.status = 'UNVERIFIED';
    await this.batchesRepo.save(batch);

    const mappings = logs.map(log =>
      this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
    );
    await this.mappingRepo.save(mappings);

    this.logger.warn(
      `Batch ${batch.id} sealed but unconfirmed (tx=${batch.txHash?.slice(0, 12)}...) — ` +
        'marked UNVERIFIED, next verify round will confirm it',
    );
    return batch;
  }

  /**
   * storeRoot revert ด้วย "Root already exists" — อ่าน root จริงบน chain มาตัดสิน
   *   ตรงกับที่เพิ่งคำนวณ  -> anchor สำเร็จอยู่แล้ว ปิดงานเป็น CONFIRMED
   *   ไม่ตรง               -> มี root คนละตัวใต้ batch id เดียวกัน = ผิดปกติจริง ปล่อยเป็น FAILED
   */
  private async adoptExistingRoot(batch: Batch, logs: Log[], root: string): Promise<Batch> {
    try {
      const { result, onChainRoot } = await this.blockchain.checkRoot(batch.id, root);

      if (result === 'MATCH') {
        this.logger.warn(
          `Batch ${batch.id} root already anchored on chain — treating as confirmed (no new tx)`,
        );
        return await this.confirmBatch(batch, logs, root);
      }

      this.logger.error(
        `Batch ${batch.id} collides with a different on-chain root ` +
          `(onChain=${onChainRoot?.slice(0, 18)}... computed=${root.slice(0, 18)}...)`,
      );
    } catch (err: any) {
      this.logger.error(`Batch ${batch.id} — cannot read on-chain root: ${err.message}`);
    }

    batch.status = 'FAILED';
    await this.batchesRepo.save(batch);
    return batch;
  }

    /**
   * Verify batch ที่ CONFIRMED และ UNVERIFIED
   * (UNVERIFIED ถูก re-check ด้วย เผื่อ chain กลับมา / tx ถูก confirm ทีหลัง)
   */
  async verifyAllBatches(): Promise<void> {
    if (!this.blockchain.ready) return;

    const batches = await this.batchesRepo.find({
      where: [
        { status: 'CONFIRMED' }, 
        { status: 'UNVERIFIED' },
        { status: 'TAMPERED' },
      ],
    });

    for (const batch of batches) {
      const leaves = await this.getLeavesForBatch(batch.id);
      const { root } = this.merkle.buildTree(leaves);
      const { result, onChainRoot } = await this.blockchain.checkRoot(batch.id, root);

      if (result === 'MISMATCH') {
        // root อยู่บน chain แต่ไม่ตรง = ข้อมูลถูกแก้ไขจริง
        await this.raiseTamperAlert(batch, root, onChainRoot);
        batch.status = 'TAMPERED';
        await this.batchesRepo.save(batch);
      } else if (result === 'MISSING') {
        // ไม่มี root บน chain — verify ไม่ได้ ไม่ใช่หลักฐาน tamper
        if (batch.status !== 'UNVERIFIED') {
          this.logger.warn(
            `Batch ${batch.id} unverifiable — no root on chain (tx=${batch.txHash?.slice(0, 12)}...). ` +
              'Likely chain reset or unconfirmed tx, not tampering.',
          );
          batch.status = 'UNVERIFIED';
          await this.batchesRepo.save(batch);
        }
      } else if (batch.status !== 'CONFIRMED') {
        // เคย unverifiable แต่ตอนนี้ verify ผ่าน → กลับเป็น CONFIRMED
        this.logger.log(`Batch ${batch.id} re-verified (${batch.status} → CONFIRMED)`);
        batch.status = 'CONFIRMED';
        await this.batchesRepo.save(batch);
      }
    }
  }

  /**
 * Re-anchor batch ที่ verify ไม่ได้ (chain reset / redeploy)
 * ใข้ root เดินจาก DB เท่านั้น - ไม่ recompute
 * ถ้า log ถูกแก้จริง รอบ verify ถัดไปจะจับได้เป็น MISMATCH ตามปกติ
 */
async reanchorUnverified(): Promise<void> {
  if (!this.blockchain.ready) return;
  if (process.env.INTEGRITY_AUTO_REANCHOR !== 'true') return;

  const batches = await this.batchesRepo.find({ where: { status: 'UNVERIFIED' } });
  if (batches.length === 0) return;

  for (const batch of batches) {
    try {
      const storeRoot = '0x' + batch.merkleRoot;
      const { result } = await this.blockchain.checkRoot(batch.id, storeRoot);
      if (result !== 'MISSING') continue;

      const { txHash, blockNumber } = await this.blockchain.storeRoot(batch.id, storeRoot);
      batch.txHash = txHash;
      batch.blockNumber = blockNumber;
      await this.batchesRepo.save(batch);
      
      this.logger.warn(
        `Batch ${batch.id} re-anchored after chain reset (root unchanged) tx=${txHash.slice(0, 12)}...`
      );
    } catch (err: any) {
      // root โผล่บน chain ระหว่าง checkRoot กับ storeRoot (หรือ tx เก่าเพิ่ง confirm)
      // = ไม่ต้อง re-anchor แล้ว ไม่ใช่ error — และห้ามตั้ง FAILED
      if (classifyChainError(err) === 'ROOT_EXISTS') {
        this.logger.debug(`Batch ${batch.id} already anchored on chain — skip re-anchor`);
        continue;
      }
      this.logger.error(`Re-anchor failed for batch ${batch.id}: ${err.message}`);
    }
  }
}

  /**
   * helper — ดึง rawHash ของ logs ใน batch (เรียงตามลำดับเดิม)
   */
  private async getLeavesForBatch(batchId: string): Promise<string[]> {
    const mappings = await this.mappingRepo.find({ where: { batchId } });
    const logIds = mappings.map(m => m.logId);
    if (logIds.length === 0) return [];

    const logs = await this.logsRepo.find({
      where: { id: In(logIds) },
      order: { createdAt: 'ASC', id: 'ASC' },   // ต้องตรงกับ sealBatch
    });
    return logs.map(l => l.rawHash);
  }

  private async raiseTamperAlert(
    batch: Batch,
    recomputedRoot: string,
    onChainRoot: string,
  ): Promise<void> {
    const existing = await this.alertsRepo.findOne({
      where: { batchId: batch.id, alertType: 'INTEGRITY_TAMPERED' },
    });
    if (existing) return;

    await this.alertsRepo.save(
      this.alertsRepo.create({
        batchId: batch.id,
        alertType: 'INTEGRITY_TAMPERED',
        severity: 'CRITICAL',
        source: 'INTEGRITY',
        title: `Batch ${batch.id} integrity violation detected`,
        detail: {
          batchId: batch.id,
          storedRoot: batch.merkleRoot,
          recomputedRoot,
          onChainRoot,
          txHash: batch.txHash,
          message:
            'On-chain root exists but does not match the recomputed root — log data was modified after sealing',
        },
        status: 'OPEN',
      }),
    );

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
