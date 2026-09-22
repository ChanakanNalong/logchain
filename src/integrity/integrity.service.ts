import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { MerkleService } from './service/merkle.service';
import {
  BlockchainService,
  classifyChainError,
} from '../blockchain/blockchain.service';
import { isRawHashIntact } from '../logs/services/log-hash';

const BATCH_SIZE = 100; // กำหนดขนาด batch

/**
 * สถานะของ batch
 *
 *   PENDING     เพิ่งสร้าง ยังไม่รู้ผล anchor (สถานะชั่วคราวระหว่าง seal)
 *   SEALED      ปิด Merkle tree + ผูก mapping แล้ว แต่ยังไม่ได้ anchor ขึ้น chain
 *   UNVERIFIED  ส่ง tx แล้วแต่ยังยืนยันกับ chain ไม่ได้
 *   CONFIRMED   anchor แล้วและ verify กับ chain ผ่าน
 *   TAMPERED    ตรวจเจอว่าข้อมูลถูกแก้หลัง seal
 *   FAILED      anchor ไม่สำเร็จ (mapping ไม่ถูกเขียน — batch ใบนี้ไม่มี log ผูกจริง)
 *
 * **seal กับ anchor เป็นคนละเรื่องกัน**
 * seal = ปิดชุด log แล้วคำนวณ Merkle root · anchor = เอา root ไปตรึงไว้บน chain
 * Merkle root / per-log proof / การจับว่า row ถูกแก้ ใช้ได้ตั้งแต่ seal โดยไม่ต้องมี chain
 * สิ่งที่ anchor เพิ่มให้คือ root ถูกเก็บไว้ **นอก** ฐานข้อมูลเดียวกับ log — คนที่แก้ทั้ง
 * `logs` และ `batches.merkle_root` พร้อมกันจะรอดจากการตรวจแบบ local แต่ไม่รอดจาก chain
 */

@Injectable()
export class IntegrityService {
  private readonly logger = new Logger(IntegrityService.name);

  constructor(
    @InjectRepository(Log) private readonly logsRepo: Repository<Log>,
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    @InjectRepository(Alert) private readonly alertsRepo: Repository<Alert>,
    @InjectRepository(LogBatchMapping)
    private readonly mappingRepo: Repository<LogBatchMapping>,
    private readonly merkle: MerkleService,
    private readonly blockchain: BlockchainService,
  ) {}

  /**
   * Seal batch — รวม logs ที่ยังไม่ถูก map เข้า batch
   *
   * ทำงานได้โดยไม่ต้องมี blockchain: ถ้า chain ไม่พร้อมจะปิด batch เป็น SEALED
   * แล้วให้ anchorSealedBatches() มาตรึงขึ้น chain ทีหลังเมื่อ config ครบ
   */
  async sealBatch(): Promise<Batch | null> {
    // 1. หา log_id ที่ถูก map แล้ว (เพื่อ exclude)
    const mapped = await this.mappingRepo.find({ select: { logId: true } });
    const mappedIds = mapped.map((m) => m.logId);

    // 2. logs ที่ยังไม่ถูก map (batch ใหม่)
    const pendingLogs = await this.logsRepo.find({
      where: mappedIds.length > 0 ? { id: Not(In(mappedIds)) } : {},
      order: { createdAt: 'ASC', id: 'ASC' }, // ต้องตรงกับ getLeavesForBatch
      take: BATCH_SIZE,
    });

    if (pendingLogs.length === 0) {
      this.logger.debug('No pending logs to seal');
      return null;
    }

    // 3. สร้าง Merkle tree
    const leaves = pendingLogs.map((log) => log.rawHash);
    const { root } = this.merkle.buildTree(leaves);

    // 4. สร้าง batch (PENDING)
    const batch = await this.batchesRepo.save(
      this.batchesRepo.create({
        merkleRoot: root.replace('0x', ''),
        logCount: pendingLogs.length,
        status: 'PENDING',
      }),
    );

    // 5. ไม่มี chain ก็ปิด batch ได้ — root กับ mapping คือของที่ proof และ
    //    tamper detection ต้องใช้ ส่วน anchor เป็นชั้นที่เติมทีหลังได้
    if (!this.blockchain.ready) {
      return await this.sealWithoutAnchor(batch, pendingLogs, root);
    }

    try {
      // 6. commit root ขึ้น chain
      const { txHash, blockNumber, confirmed } =
        await this.blockchain.storeRoot(batch.id, root);

      batch.txHash = txHash;
      batch.blockNumber = blockNumber;

      // tx ส่งแล้วแต่รอ confirm ไม่ทัน (public RPC ช้า) — ไม่ใช่ FAILED และห้ามค้าง PENDING
      // ปล่อยเป็น UNVERIFIED ให้ verifyAllBatches ตามผลต่อ: tx ลงเมื่อไร -> MATCH -> CONFIRMED
      if (confirmed === false)
        return await this.deferConfirmation(batch, pendingLogs);

      return await this.confirmBatch(batch, pendingLogs, root);
    } catch (err) {
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
   * ปิด batch โดยไม่ anchor — ใช้เมื่อยังไม่ได้ตั้ง blockchain (ไม่มี CONTRACT_ADDRESS
   * หรือไม่มี private key ใน Vault) ซึ่งเป็นสภาพปกติของคนที่เพิ่ง clone repo มารัน
   *
   * ต้องเขียน mapping เหมือน path ปกติ ไม่งั้น getLeavesForBatch คืน [] แล้วทั้ง
   * proof และ verify รอบถัดไปจะคำนวณจาก leaf ว่าง
   *
   * ⚠️ การรับประกันต่ำกว่า CONFIRMED: root ถูกเก็บไว้ใน DB ก้อนเดียวกับ log
   * คนที่แก้ `logs` ได้และแก้ `batches.merkle_root` ตามได้ด้วยจะไม่ถูกจับ
   * การ anchor คือสิ่งที่ปิดช่องนี้ — ย้าย root ไปไว้นอก DB
   */
  private async sealWithoutAnchor(
    batch: Batch,
    logs: Log[],
    root: string,
  ): Promise<Batch> {
    batch.status = 'SEALED';
    await this.batchesRepo.save(batch);

    const mappings = logs.map((log) =>
      this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
    );
    await this.mappingRepo.save(mappings);

    this.logger.log(
      `Batch ${batch.id} sealed (ไม่ anchor): ${logs.length} log, root=${root.slice(0, 18)}... — ` +
        'ตั้ง CONTRACT_ADDRESS + BLOCKCHAIN_PRIVATE_KEY เพื่อให้ถูก anchor ขึ้น chain',
    );
    return batch;
  }

  /**
   * ตรึง batch ที่ seal ไว้ตอน chain ยังไม่พร้อมขึ้น chain ย้อนหลัง
   *
   * ต่างจาก reanchorUnverified() ตรงที่ batch พวกนี้ **ไม่เคยถูก anchor มาก่อน**
   * จึงไม่มีความกำกวมว่า root บน chain หายไปเพราะอะไร — ไม่ต้องรอ flag
   * INTEGRITY_AUTO_REANCHOR เหมือนกรณี chain reset
   */
  async anchorSealedBatches(): Promise<void> {
    if (!this.blockchain.ready) return;

    const batches = await this.batchesRepo.find({ where: { status: 'SEALED' } });
    if (batches.length === 0) return;

    for (const batch of batches) {
      const root = '0x' + batch.merkleRoot;
      try {
        const { txHash, blockNumber, confirmed } =
          await this.blockchain.storeRoot(batch.id, root);
        batch.txHash = txHash;
        batch.blockNumber = blockNumber;

        // mapping ถูกเขียนไปแล้วตอน seal — ที่นี่แค่เลื่อนสถานะ
        batch.status = confirmed === false ? 'UNVERIFIED' : 'CONFIRMED';
        if (batch.status === 'CONFIRMED') batch.confirmedAt = new Date();
        await this.batchesRepo.save(batch);

        this.logger.log(
          `Batch ${batch.id} anchored ย้อนหลัง (${batch.status}) tx=${txHash.slice(0, 12)}...`,
        );
      } catch (err: any) {
        // root ตัวนี้อยู่บน chain อยู่แล้ว = เคย anchor สำเร็จแต่ status ไม่ทันอัปเดต
        if (classifyChainError(err) === 'ROOT_EXISTS') {
          const { result } = await this.blockchain.checkRoot(batch.id, root);
          if (result === 'MATCH') {
            batch.status = 'CONFIRMED';
            batch.confirmedAt = new Date();
            await this.batchesRepo.save(batch);
            this.logger.warn(
              `Batch ${batch.id} root อยู่บน chain อยู่แล้ว — ตั้งเป็น CONFIRMED`,
            );
            continue;
          }
        }
        // anchor ไม่ผ่านก็ปล่อยค้าง SEALED ไว้ **ห้ามตั้ง FAILED** — batch ใบนี้มี
        // mapping ครบและ verify แบบ local ได้ปกติ รอบถัดไปค่อยลอง anchor ใหม่
        this.logger.error(
          `Anchor batch ${batch.id} ไม่สำเร็จ (ยังเป็น SEALED): ${err.message}`,
        );
      }
    }
  }

  /**
   * ปิดงาน batch ที่ anchor สำเร็จ — ตั้ง CONFIRMED + ผูก mapping
   * (แยกออกมาเพราะทั้ง path ปกติและ path "root อยู่บน chain แล้ว" ใช้ร่วมกัน)
   */
  private async confirmBatch(
    batch: Batch,
    logs: Log[],
    root: string,
  ): Promise<Batch> {
    batch.status = 'CONFIRMED';
    batch.confirmedAt = new Date();
    await this.batchesRepo.save(batch);

    // INSERT mapping (ไม่ใช่ UPDATE logs - logs ยัง imutable)
    const mappings = logs.map((log) =>
      this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
    );
    await this.mappingRepo.save(mappings);

    this.logger.log(
      `Batch ${batch.id} sealed: ${logs.length} log, root=${root.slice(0, 18)}...`,
    );
    return batch;
  }

  /**
   * tx ขึ้น chain แล้วแต่ยังไม่ confirm ในเวลาที่รอ — ผูก mapping ไว้เหมือน batch ปกติ
   * แล้วตั้ง UNVERIFIED เพื่อให้ verifyAllBatches recompute root แล้วตามผลเอง
   *
   * ต้องเขียน mapping ด้วย ไม่งั้น getLeavesForBatch คืน [] แล้ว verify รอบถัดไป
   * จะคำนวณ root จาก leaf ว่าง = ไม่มีวันตรงกับที่ anchor ไว้
   */
  private async deferConfirmation(batch: Batch, logs: Log[]): Promise<Batch> {
    batch.status = 'UNVERIFIED';
    await this.batchesRepo.save(batch);

    const mappings = logs.map((log) =>
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
  private async adoptExistingRoot(
    batch: Batch,
    logs: Log[],
    root: string,
  ): Promise<Batch> {
    try {
      const { result, onChainRoot } = await this.blockchain.checkRoot(
        batch.id,
        root,
      );

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
      this.logger.error(
        `Batch ${batch.id} — cannot read on-chain root: ${err.message}`,
      );
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
    const batches = await this.batchesRepo.find({
      where: [
        { status: 'CONFIRMED' },
        { status: 'UNVERIFIED' },
        { status: 'TAMPERED' },
        { status: 'SEALED' },
      ],
    });

    for (const batch of batches) {
      const logs = await this.getLogsForBatch(batch.id);
      const { root } = this.merkle.buildTree(logs.map((l) => l.rawHash));

      // root ตรวจได้แค่ว่า raw_hash ยังเป็นชุดเดิมไหม — ไม่ได้ตรวจว่า "เนื้อ log ยังตรงกับ hash ของตัวเอง"
      // คนที่เข้าถึง DB ได้อาจแก้ severity/sourceIp ทิ้ง raw_hash ไว้เหมือนเดิม แล้ว root ยังตรง
      // จึงต้อง recompute hash จาก field ของ row เทียบกับ raw_hash ที่ผูกไว้ตอน insert ด้วย
      const modified = logs.filter((l) => !isRawHashIntact(l));

      // เทียบกับ chain ไม่ได้ก็ยังตรวจแบบ local ได้ — 2 กรณี:
      //   - batch เป็น SEALED (ไม่เคย anchor จึงไม่มีอะไรให้เทียบบน chain)
      //   - chain ใช้ไม่ได้ชั่วคราว (RPC ล่ม / ถอด config ออก)
      // เดิมทั้งสองกรณี return ทิ้งตั้งแต่ต้นฟังก์ชัน = ไม่ตรวจอะไรเลย
      if (batch.status === 'SEALED' || !this.blockchain.ready) {
        await this.verifyLocally(batch, root, modified);
        continue;
      }

      const { result, onChainRoot } = await this.blockchain.checkRoot(
        batch.id,
        root,
      );

      if (result === 'MISMATCH' || modified.length > 0) {
        // ข้อมูลถูกแก้ไขจริง — root ไม่ตรง chain หรือ row ไม่ตรง hash ของตัวเอง
        await this.raiseTamperAlert(batch, root, onChainRoot, modified);
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
      } else {
        // verify ผ่าน (root ตรง chain + ทุก row ตรง raw_hash ของตัวเอง)
        if (batch.status !== 'CONFIRMED') {
          // เคย unverifiable/tampered แต่ตอนนี้ verify ผ่าน → กลับเป็น CONFIRMED
          this.logger.log(
            `Batch ${batch.id} re-verified (${batch.status} → CONFIRMED)`,
          );
          batch.status = 'CONFIRMED';
          await this.batchesRepo.save(batch);
        }
        // ปิด alert เก่าที่ยังค้างอยู่เสมอ ไม่ใช่เฉพาะตอนเพิ่งเปลี่ยน status —
        // batch ที่เคย TAMPERED แล้วถูกแก้กลับจะกลายเป็น CONFIRMED ตั้งแต่รอบก่อน
        // ทำให้เงื่อนไขด้านบนไม่เข้า และ alert ค้าง OPEN อยู่บน batch ที่ CONFIRMED
        // (dashboard เลยโชว์ integrity 100% พร้อม tamper alert ที่ไม่มีวันหาย)
        await this.resolveTamperAlerts(batch);
      }
    }
  }

  /**
   * ตรวจ batch โดยไม่ใช้ chain — เทียบ root ที่คำนวณใหม่กับ root ที่เก็บไว้ใน DB
   * บวกกับเช็คว่าแต่ละ row ยังตรงกับ raw_hash ของตัวเอง
   *
   * จับได้: แก้เนื้อ log, ลบ log ออกจาก batch, สลับลำดับ, ยัด log เพิ่ม
   * จับไม่ได้: คนที่แก้ `logs` แล้วแก้ `batches.merkle_root` ให้สอดคล้องกันด้วย
   *            (ช่องนี้ปิดด้วยการ anchor เท่านั้น)
   */
  private async verifyLocally(
    batch: Batch,
    recomputedRoot: string,
    modified: Log[],
  ): Promise<void> {
    const rootMatches = recomputedRoot === '0x' + batch.merkleRoot;

    if (!rootMatches || modified.length > 0) {
      await this.raiseTamperAlert(batch, recomputedRoot, null, modified);
      if (batch.status !== 'TAMPERED') {
        batch.status = 'TAMPERED';
        await this.batchesRepo.save(batch);
      }
      return;
    }

    // ผ่านการตรวจเท่าที่ทำได้โดยไม่มี chain
    //
    // batch ที่เคย anchor แล้ว (มี txHash) **ห้ามเลื่อนสถานะที่นี่** — การผ่านแบบ local
    // ไม่ใช่หลักฐานเทียบเท่า chain การปล่อยให้ CONFIRMED/UNVERIFIED/TAMPERED ค้างไว้
    // แล้วรอบที่ chain กลับมาค่อยตัดสิน เป็นฝั่งที่ปลอดภัยกว่า
    if (batch.txHash) return;

    if (batch.status === 'TAMPERED') {
      // ไม่เคย anchor + เคยถูกแก้ + ตอนนี้กลับมาตรงแล้ว -> กลับเป็น SEALED
      this.logger.log(`Batch ${batch.id} re-verified แบบ local (TAMPERED → SEALED)`);
      batch.status = 'SEALED';
      await this.batchesRepo.save(batch);
    }
    await this.resolveTamperAlerts(batch);
  }

  /**
   * Re-anchor batch ที่ verify ไม่ได้ (chain reset / redeploy)
   * ใข้ root เดินจาก DB เท่านั้น - ไม่ recompute
   * ถ้า log ถูกแก้จริง รอบ verify ถัดไปจะจับได้เป็น MISMATCH ตามปกติ
   */
  async reanchorUnverified(): Promise<void> {
    if (!this.blockchain.ready) return;
    if (process.env.INTEGRITY_AUTO_REANCHOR !== 'true') return;

    const batches = await this.batchesRepo.find({
      where: { status: 'UNVERIFIED' },
    });
    if (batches.length === 0) return;

    for (const batch of batches) {
      try {
        const storeRoot = '0x' + batch.merkleRoot;
        const { result } = await this.blockchain.checkRoot(batch.id, storeRoot);
        if (result !== 'MISSING') continue;

        const { txHash, blockNumber } = await this.blockchain.storeRoot(
          batch.id,
          storeRoot,
        );
        batch.txHash = txHash;
        batch.blockNumber = blockNumber;
        await this.batchesRepo.save(batch);

        this.logger.warn(
          `Batch ${batch.id} re-anchored after chain reset (root unchanged) tx=${txHash.slice(0, 12)}...`,
        );
      } catch (err: any) {
        // root โผล่บน chain ระหว่าง checkRoot กับ storeRoot (หรือ tx เก่าเพิ่ง confirm)
        // = ไม่ต้อง re-anchor แล้ว ไม่ใช่ error — และห้ามตั้ง FAILED
        if (classifyChainError(err) === 'ROOT_EXISTS') {
          this.logger.debug(
            `Batch ${batch.id} already anchored on chain — skip re-anchor`,
          );
          continue;
        }
        this.logger.error(
          `Re-anchor failed for batch ${batch.id}: ${err.message}`,
        );
      }
    }
  }

  /**
   * helper — ดึง logs ใน batch (เรียงตามลำดับเดิมที่ใช้ตอน seal)
   * leaf ของ Merkle tree = rawHash ของแต่ละ log ตามลำดับนี้
   */
  private async getLogsForBatch(batchId: string): Promise<Log[]> {
    const mappings = await this.mappingRepo.find({ where: { batchId } });
    const logIds = mappings.map((m) => m.logId);
    if (logIds.length === 0) return [];

    return this.logsRepo.find({
      where: { id: In(logIds) },
      order: { createdAt: 'ASC', id: 'ASC' }, // ต้องตรงกับ sealBatch
    });
  }

  private async getLeavesForBatch(batchId: string): Promise<string[]> {
    const logs = await this.getLogsForBatch(batchId);
    return logs.map((l) => l.rawHash);
  }

  /** ปิด INTEGRITY_TAMPERED ที่ยังค้างของ batch ที่ verify ผ่านแล้ว */
  private async resolveTamperAlerts(batch: Batch): Promise<void> {
    const { affected } = await this.alertsRepo.update(
      { batchId: batch.id, alertType: 'INTEGRITY_TAMPERED', status: 'OPEN' },
      { status: 'RESOLVED' },
    );
    if (affected) {
      this.logger.log(
        `Batch ${batch.id} verified clean — resolved ${affected} stale INTEGRITY_TAMPERED alert(s)`,
      );
    }
  }

  private async raiseTamperAlert(
    batch: Batch,
    recomputedRoot: string,
    // null = ตรวจแบบ local ไม่ได้เทียบกับ chain (ดู verifyLocally)
    onChainRoot: string | null,
    modifiedLogs: Log[] = [],
  ): Promise<void> {
    // ต้องกรอง status: 'OPEN' ด้วย — ถ้าเช็คแค่ batchId+alertType ตัว alert ที่ถูก
    // resolve ไปแล้วจะบล็อกการแจ้งเตือนรอบใหม่ตลอดไป แปลว่า batch ที่เคยถูกแก้
    // แล้วแก้ซ้ำอีกครั้งจะเงียบสนิท
    const existing = await this.alertsRepo.findOne({
      where: {
        batchId: batch.id,
        alertType: 'INTEGRITY_TAMPERED',
        status: 'OPEN',
      },
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
          modifiedLogIds: modifiedLogs.map((l) => l.id),
          message:
            modifiedLogs.length > 0
              ? `${modifiedLogs.length} log(s) no longer match their own raw_hash — row data was modified after sealing`
              : onChainRoot === null
                ? 'Recomputed root does not match the root stored at seal time — the batch contents changed after sealing'
                : 'On-chain root exists but does not match the recomputed root — log data was modified after sealing',
        },
        status: 'OPEN',
      }),
    );

    this.logger.error(`TAMPER DETECTED on batch ${batch.id}`);
  }

  /**
   * batch ล่าสุดเรียงตามเวลา seal — ใช้บนหน้า Verify เพื่อให้เห็นว่ามีอะไรถูก
   * ผูกขึ้น chain ไปแล้วบ้าง โดยไม่ต้องมี log id ในมือก่อน
   */
  async listBatches(limit = 10) {
    const batches = await this.batchesRepo.find({
      order: { sealedAt: 'DESC' },
      take: limit,
    });

    return batches.map((batch) => ({
      id: batch.id,
      merkleRoot: batch.merkleRoot,
      txHash: batch.txHash,
      blockNumber: batch.blockNumber,
      status: batch.status,
      logCount: batch.logCount,
      sealedAt: batch.sealedAt,
      confirmedAt: batch.confirmedAt,
    }));
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
    const verified = this.merkle.verifyProof(
      log.rawHash,
      proof,
      '0x' + batch.merkleRoot,
    );

    return { log, batch, proof, verified };
  }
}
