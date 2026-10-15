import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { DetectionService } from './detection.service';
import { isRawHashIntact, rawHashCanonical } from '../logs/services/log-hash';
import { BatchLogSnapshot } from './entities/batch-log-snapshot.entity';
import { explorerTxUrl } from '../blockchain/explorer';
import { ethers } from 'ethers';
import { readSealConfig, SealConfig, SealSkippedError } from './seal-config';

/** alert ที่ guard ยอดเงินต่ำยกขึ้น (ไม่ผูก batch — batch ยังไม่ถูกสร้าง) */
export const LOW_BALANCE_ALERT_TYPE = 'WALLET_LOW_BALANCE';

/**
 * เพดาน batch ต่อรอบ cron — กันวนไม่จบถ้า mapping ไม่ถูกเขียนแต่ batch ไม่ FAILED (บั๊ก)
 * 1,000 × batch size 100 = 100,000 log ต่อรอบ เกินกว่านี้รอบถัดไปปิดต่อ
 */
const MAX_BATCHES_PER_TICK = 1000;

/** แถวดิบของ GET /batches (ชื่อคอลัมน์ Postgres) */
interface BatchListRow {
  id: string;
  merkle_root: string;
  tx_hash: string | null;
  block_number: string | number | null;
  status: string;
  log_count: number;
  sealed_at: Date;
  confirmed_at: Date | null;
  if_anomaly: boolean | null;
  if_score: number | null;
  if_reason: string | null;
  if_scored_at: Date | null;
  has_snapshot: boolean;
  total: string | number;
}

/** ผลของรอบ seal ตาม cron — skipped = รอบนี้ไม่ได้พยายาม seal (log ยังค้างครบ) */
export interface SealRunResult {
  batches: Batch[];
  skipped?: 'IN_FLIGHT' | 'BACKOFF' | 'LOW_BALANCE';
}

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

  /**
   * คิวของ sealBatch — ให้ปิดทีละครั้งภายใน process
   * ถ้าปล่อยขนาน (cron ทุกนาทีชนกับ POST /integrity/seal-now) ทุกตัวจะเห็น log ค้างชุดเดียวกัน
   * สร้าง batch หลายใบ ใบแรกเขียน mapping ได้ ใบอื่นชน PK ของ log_batch_mapping แล้วเหลือเป็น
   * batch ที่ไม่มี log ผูก — ใบที่ anchor สำเร็จก่อนชนจะค้าง CONFIRMED ทั้งที่ไม่มี log (เสีย gas ฟรี)
   * (เทสต์ IM-12 ใน test/report-cases.integration.spec.ts) · ระบบรัน backend ตัวเดียว คิวใน process จึงพอ
   * ถ้าวันหน้ารันหลาย replica ต้องเปลี่ยนเป็น Postgres advisory lock
   */
  private sealQueue: Promise<unknown> = Promise.resolve();

  /** ค่าตั้งของรอบ seal (SEAL_* env) — ดู seal-config.ts */
  readonly sealConfig: SealConfig = readSealConfig(process.env);

  /** รอบ cron ก่อนหน้ายัง drain ไม่จบ — กันรอบซ้อน (seal ทีละ tx อาจนานกว่า 1 รอบ) */
  private drainInFlight = false;
  /** seal ล้มติดกันกี่ครั้ง (FAILED หรือ throw) · reset เมื่อสำเร็จ */
  private consecutiveFailures = 0;
  /** รอบ cron ที่ต้องข้ามที่เหลือ (exponential backoff) */
  private backoffTicksLeft = 0;
  /**
   * ยอดเงินต่ำค้างอยู่ — ไว้ log ตอนฟื้นและปิด alert
   * เริ่มเป็น true: process ก่อนหน้าอาจทิ้ง alert OPEN ไว้ (restart ระหว่างยอดต่ำ)
   * เช็คผ่านครั้งแรกจึงปิดของค้างให้ด้วย ไม่งั้น alert ค้าง OPEN ตลอดไป
   */
  private lowBalance = true;
  private lastLowBalanceAlertAt = 0;

  constructor(
    @InjectRepository(Log) private readonly logsRepo: Repository<Log>,
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    @InjectRepository(Alert) private readonly alertsRepo: Repository<Alert>,
    @InjectRepository(LogBatchMapping)
    private readonly mappingRepo: Repository<LogBatchMapping>,
    private readonly merkle: MerkleService,
    private readonly blockchain: BlockchainService,
    // Isolation Forest ระดับที่ 3 เป็นส่วนเสริม — @Optional เพื่อให้เทสต์/บริบทที่ไม่ wire
    // ยังสร้าง service ได้ และการปิด batch ไม่พึ่งพา detection
    @Optional() private readonly detection?: DetectionService,
  ) {}

  /**
   * Seal batch — รวม logs ที่ยังไม่ถูก map เข้า batch
   *
   * ทำงานได้โดยไม่ต้องมี blockchain: ถ้า chain ไม่พร้อมจะปิด batch เป็น SEALED
   * แล้วให้ anchorSealedBatches() มาตรึงขึ้น chain ทีหลังเมื่อ config ครบ
   */
  sealBatch(): Promise<Batch | null> {
    const run = this.sealQueue
      .then(() => this.sealBatchNow())
      .then(
        (batch) => {
          if (batch) this.recordSealOutcome(batch.status !== 'FAILED');
          return batch;
        },
        (err) => {
          // ข้ามเพราะยอดเงินต่ำไม่ใช่ความล้มเหลวของ seal — ไม่นับเข้า backoff
          if (!(err instanceof SealSkippedError)) this.recordSealOutcome(false);
          throw err;
        },
      );
    // ตัวถัดไปในคิวต้องรอตัวนี้จบ ไม่ว่าจะสำเร็จหรือ throw
    this.sealQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * รอบ seal ของ cron — ปิด batch ทีละ sealConfig.batchSize จนไม่มี log ค้าง
   *
   * วนผ่าน sealBatch() ทีละใบ คิว sealQueue จึงยังกัน seal-now ที่ยิงแทรกได้เหมือนเดิม
   * และลำดับยังเป็น createdAt ASC, id ASC (แต่ละใบหยิบ log ค้างที่เก่าสุดก่อน)
   * หยุดเมื่อ: ไม่มี log ค้าง · batch ไม่เต็ม (= หมดแล้ว ไม่ต้อง query ซ้ำ) ·
   * batch FAILED (log ชุดเดิมยังไม่ถูก map — วนต่อจะ seal ชุดเดิมซ้ำในรอบเดียว) · guard ยอดเงิน
   */
  async runScheduledSeal(): Promise<SealRunResult> {
    if (this.drainInFlight) {
      this.logger.debug(
        'Previous seal round still running — skipping this tick',
      );
      return { batches: [], skipped: 'IN_FLIGHT' };
    }
    if (this.backoffTicksLeft > 0) {
      this.backoffTicksLeft--;
      this.logger.warn(
        `Seal backoff: skipping tick after ${this.consecutiveFailures} consecutive failures ` +
          `(${this.backoffTicksLeft} more to skip)`,
      );
      return { batches: [], skipped: 'BACKOFF' };
    }

    this.drainInFlight = true;
    const batches: Batch[] = [];
    try {
      for (;;) {
        let batch: Batch | null;
        try {
          batch = await this.sealBatch();
        } catch (err) {
          if (err instanceof SealSkippedError) {
            return { batches, skipped: err.reason };
          }
          throw err;
        }
        if (!batch) break;
        batches.push(batch);
        if (batch.status === 'FAILED') break;
        if (batch.logCount < this.sealConfig.batchSize) break;
        if (batches.length >= MAX_BATCHES_PER_TICK) {
          this.logger.warn(
            `Seal round hit ${MAX_BATCHES_PER_TICK} batches — continuing next tick`,
          );
          break;
        }
      }
      if (batches.length > 1) {
        this.logger.log(
          `Seal round drained backlog: ${batches.length} batches, ` +
            `${batches.reduce((n, b) => n + b.logCount, 0)} logs`,
        );
      }
      return { batches };
    } finally {
      this.drainInFlight = false;
    }
  }

  /** นับผล seal สำหรับ backoff — ล้มครบ N ครั้งติดกันแล้วข้าม 2^(ครั้งที่เกิน N) รอบ */
  private recordSealOutcome(ok: boolean): void {
    if (ok) {
      if (this.consecutiveFailures > 0) {
        this.logger.log(
          `Seal succeeded after ${this.consecutiveFailures} consecutive failure(s) — backoff reset`,
        );
      }
      this.consecutiveFailures = 0;
      this.backoffTicksLeft = 0;
      return;
    }

    this.consecutiveFailures++;
    const after = this.sealConfig.failureBackoffAfter;
    if (after <= 0 || this.consecutiveFailures < after) return;

    // exponent มีเพดาน — กัน 2 ** n ล้นจนได้ Infinity เมื่อล้มต่อเนื่องเป็นวัน
    const exp = Math.min(this.consecutiveFailures - after, 30);
    this.backoffTicksLeft = Math.min(2 ** exp, this.sealConfig.backoffMaxTicks);
    this.logger.warn(
      `Seal failed ${this.consecutiveFailures} times in a row — skipping the next ` +
        `${this.backoffTicksLeft} tick(s) instead of creating another FAILED batch every tick`,
    );
  }

  /**
   * guard ยอดเงินต่ำ — เรียกก่อนสร้าง batch เท่านั้น (ไม่มี chain = ไม่มี tx = ไม่ต้องเช็ค)
   * ยอด < SEAL_MIN_BALANCE_TX × ค่า storeRoot โดยประมาณ → throw SealSkippedError (log ค้าง pending)
   * เช็คยอดไม่ได้ (RPC พัง) → seal ต่อ: ถ้า RPC พังจริง storeRoot จะ FAILED แล้ว backoff รับช่วง
   */
  private async checkWalletBalance(): Promise<void> {
    const minTx = this.sealConfig.minBalanceTx;
    if (minTx <= 0 || !this.blockchain.ready) return;

    let est: Awaited<ReturnType<BlockchainService['estimateStoreRootCost']>>;
    try {
      est = await this.blockchain.estimateStoreRootCost();
    } catch (err) {
      this.logger.warn(
        `Cannot check wallet balance (${(err as Error).message}) — sealing anyway`,
      );
      return;
    }

    const requiredWei = est.costWei * BigInt(minTx);
    const pol = (wei: bigint) => ethers.formatEther(wei);
    if (est.balanceWei >= requiredWei) {
      if (this.lowBalance) {
        this.lowBalance = false;
        const { affected } = await this.alertsRepo.update(
          { alertType: LOW_BALANCE_ALERT_TYPE, status: 'OPEN' },
          { status: 'RESOLVED' },
        );
        if (affected) {
          this.logger.log(
            `Wallet balance recovered: ${pol(est.balanceWei)} POL ≥ ${pol(requiredWei)} — ` +
              `sealing resumed, resolved ${affected} ${LOW_BALANCE_ALERT_TYPE} alert(s)`,
          );
        }
      }
      return;
    }

    this.lowBalance = true;
    const message =
      `Wallet ${est.address} balance ${pol(est.balanceWei)} POL is below ` +
      `${minTx} × storeRoot (~${pol(est.costWei)} POL each = ${pol(requiredWei)} POL) — ` +
      'not creating a batch; logs stay pending';
    this.logger.warn(message);
    await this.raiseLowBalanceAlert(est, requiredWei, message);
    throw new SealSkippedError('LOW_BALANCE', message);
  }

  /** alert ยอดเงินต่ำ — ไม่ถี่กว่า SEAL_LOW_BALANCE_ALERT_MINUTES และไม่ซ้ำกับใบที่ยัง OPEN */
  private async raiseLowBalanceAlert(
    est: { address: string; balanceWei: bigint; gas: bigint; costWei: bigint },
    requiredWei: bigint,
    message: string,
  ): Promise<void> {
    const now = Date.now();
    const intervalMs = this.sealConfig.lowBalanceAlertMinutes * 60_000;
    if (now - this.lastLowBalanceAlertAt < intervalMs) return;
    this.lastLowBalanceAlertAt = now;

    try {
      const existing = await this.alertsRepo.findOne({
        where: {
          alertType: LOW_BALANCE_ALERT_TYPE,
          source: 'INTEGRITY',
          status: 'OPEN',
        },
      });
      if (existing) return;

      await this.alertsRepo.save(
        this.alertsRepo.create({
          alertType: LOW_BALANCE_ALERT_TYPE,
          severity: 'HIGH',
          source: 'INTEGRITY',
          title: 'Wallet balance too low to anchor batches — sealing paused',
          detail: {
            wallet: est.address,
            balanceWei: est.balanceWei.toString(),
            requiredWei: requiredWei.toString(),
            estimatedGas: est.gas.toString(),
            estimatedCostWei: est.costWei.toString(),
            minBalanceTx: this.sealConfig.minBalanceTx,
            message,
          },
          status: 'OPEN',
        }),
      );
    } catch (err) {
      // alert พังต้องไม่ทำให้ guard พัง — log ยังค้าง pending อย่างปลอดภัยอยู่ดี
      this.logger.error(
        `Cannot record ${LOW_BALANCE_ALERT_TYPE} alert: ${(err as Error).message}`,
      );
    }
  }

  private async sealBatchNow(): Promise<Batch | null> {
    // 1. หา log_id ที่ถูก map แล้ว (เพื่อ exclude)
    const mapped = await this.mappingRepo.find({ select: { logId: true } });
    const mappedIds = mapped.map((m) => m.logId);

    // 2. logs ที่ยังไม่ถูก map (batch ใหม่)
    const pendingLogs = await this.logsRepo.find({
      where: mappedIds.length > 0 ? { id: Not(In(mappedIds)) } : {},
      order: { createdAt: 'ASC', id: 'ASC' }, // ต้องตรงกับ getLeavesForBatch
      take: this.sealConfig.batchSize,
    });

    if (pendingLogs.length === 0) {
      this.logger.debug('No pending logs to seal');
      return null;
    }

    // 2b. ยอดเงินไม่พอ anchor → ไม่สร้าง batch เลย (ไม่ใช่สร้างแล้ว FAILED)
    await this.checkWalletBalance();

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

    // 4b. จำแนกทั้งชุดด้วย Isolation Forest (ระดับที่ 3) — ต้องไม่ทำให้ seal ล้ม
    //     ตั้งค่า if_* บน batch object ก่อน anchor ทุก return path จึงบันทึกติดไปด้วย
    await this.scoreBatchAnomaly(batch, pendingLogs);

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
   * จำแนก batch ด้วย Isolation Forest แล้วเก็บผลลง batch (ระดับที่ 3)
   *
   * ไม่มีวัน throw — detection เป็นส่วนเสริม ห้ามทำให้ปิด batch ล้ม
   * ถ้าไม่ได้ wire detection / detection ล่ม / ยังไม่ train → คืน null → if_* เป็น NULL
   * (สถานะ "ยังไม่ได้จำแนก") ต่างจาก if_anomaly=false ที่ = "จำแนกแล้วว่าปกติ"
   */
  private async scoreBatchAnomaly(batch: Batch, logs: Log[]): Promise<void> {
    if (!this.detection) return;
    try {
      const result = await this.detection.scoreBatch(
        batch.id,
        logs.map((l) => ({
          eventType: l.eventType,
          severity: l.severity,
          sourceIp: l.sourceIp,
          source: l.source,
          cdeScope: l.cdeScope,
          createdAt: new Date(l.createdAt).toISOString(),
        })),
      );
      if (!result) return;

      batch.ifAnomaly = result.isAnomaly;
      batch.ifScore = result.score;
      batch.ifReason = result.reason;
      batch.ifScoredAt = new Date();
      await this.batchesRepo.save(batch);

      if (result.isAnomaly) {
        this.logger.warn(
          `Isolation Forest จับ batch ${batch.id} เป็น anomaly (score ${result.score.toFixed(
            4,
          )}): ${result.reason}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `จำแนก batch ${batch.id} ด้วย Isolation Forest ไม่สำเร็จ: ${
          (err as Error).message
        } — ปิด batch ต่อโดยไม่มีผลจำแนก`,
      );
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
    await this.writeMappingAndSnapshot(batch, logs);

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

    const batches = await this.batchesRepo.find({
      where: { status: 'SEALED' },
    });
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
    await this.writeMappingAndSnapshot(batch, logs);

    this.logger.log(
      `Batch ${batch.id} sealed: ${logs.length} log, root=${root.slice(0, 18)}...`,
    );
    return batch;
  }

  /**
   * สถานะ batch + mapping + snapshot ใน transaction เดียว — ทั้ง 3 ที่ที่ปิด batch เรียกตัวนี้
   * (confirmBatch / deferConfirmation / sealWithoutAnchor)
   *
   * logs ต้องเป็นชุดเดียวกับที่สร้าง Merkle tree (ห้ามอ่านใหม่) — position = index ในชุดนี้ = ลำดับ leaf
   * พังตรงไหน = ไม่มีอะไรถูกเขียนเลย: batch ใน DB ยังเป็น PENDING และ log ยังไม่ถูก map
   * (path ที่ anchor แล้วตกไปที่ catch ของ sealBatchNow → FAILED · รอบถัดไป seal log ชุดเดิมใหม่)
   * เดิม save สถานะก่อนแล้วค่อยเขียน mapping แยก — mapping พังแล้วได้ batch CONFIRMED ที่ไม่มี log
   */
  private async writeMappingAndSnapshot(
    batch: Batch,
    logs: Log[],
  ): Promise<void> {
    await this.mappingRepo.manager.transaction(async (m) => {
      await m.getRepository(Batch).save(batch);
      // INSERT mapping (ไม่ใช่ UPDATE logs - logs ยัง imutable)
      await m
        .getRepository(LogBatchMapping)
        .save(
          logs.map((log) =>
            this.mappingRepo.create({ logId: log.id, batchId: batch.id }),
          ),
        );
      await m.getRepository(BatchLogSnapshot).insert(
        logs.map((log, position) => ({
          batchId: batch.id,
          logId: log.id,
          position,
          snapshot: rawHashCanonical(log),
          rawHash: log.rawHash,
        })),
      );
    });
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
    await this.writeMappingAndSnapshot(batch, logs);

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

      // RPC สะดุด (timeout ฯลฯ) ของ batch เดียว เดิม throw ออกจาก loop = batch ที่เหลือในรอบนั้นไม่ถูกตรวจเลย
      // แม้แต่แบบ local (2026-09-30: 21 ครั้ง/วัน) → ตรวจ batch นี้แบบ local แล้วไปต่อ · รอบหน้าเทียบ chain ใหม่เอง
      let check: Awaited<ReturnType<BlockchainService['checkRoot']>>;
      try {
        check = await this.blockchain.checkRoot(batch.id, root);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        this.logger.warn(
          `checkRoot ${batch.id} failed (${e.code ?? e.message}) — local check only this round`,
        );
        await this.verifyLocally(batch, root, modified);
        continue;
      }
      const { result, onChainRoot } = check;

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
      this.logger.log(
        `Batch ${batch.id} re-verified แบบ local (TAMPERED → SEALED)`,
      );
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
  /** log ปัจจุบันที่ผูกกับ batch เรียงตามลำดับ leaf (ใช้ทั้ง verify และ BatchDiffService) */
  async getLogsForBatch(batchId: string): Promise<Log[]> {
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
  /**
   * GET /batches — แบ่งหน้า + กรอง status · ใหม่สุดก่อน · total จาก COUNT(*) OVER () ใน query เดียว
   * hasSnapshot = มี snapshot ให้ diff รายตำแหน่ง (batch ที่ seal ก่อน BatchLogSnapshot = false)
   */
  async listBatches(
    opts: { limit?: number; offset?: number; status?: string } = {},
  ) {
    const limit = opts.limit ?? 10;
    const offset = opts.offset ?? 0;
    const statuses = (opts.status ?? '')
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean);
    const filter = statuses.length ? statuses : null;

    const rows: BatchListRow[] = await this.batchesRepo.query(
      `SELECT b.id, b.merkle_root, b.tx_hash, b.block_number, b.status, b.log_count,
              b.sealed_at, b.confirmed_at, b.if_anomaly, b.if_score, b.if_reason, b.if_scored_at,
              EXISTS (SELECT 1 FROM batch_log_snapshot s WHERE s.batch_id = b.id) AS has_snapshot,
              COUNT(*) OVER () AS total
         FROM batches b
        WHERE ($1::text[] IS NULL OR b.status = ANY($1))
        ORDER BY b.sealed_at DESC, b.id DESC
        LIMIT $2 OFFSET $3`,
      [filter, limit, offset],
    );
    let total = rows.length ? Number(rows[0].total) : 0;
    if (!rows.length && offset > 0) {
      const counted: Array<{ count: string }> = await this.batchesRepo.query(
        `SELECT COUNT(*) AS count FROM batches b
          WHERE ($1::text[] IS NULL OR b.status = ANY($1))`,
        [filter],
      );
      total = Number(counted[0]?.count ?? 0);
    }

    return {
      items: rows.map((r) => ({
        id: r.id,
        merkleRoot: r.merkle_root,
        txHash: r.tx_hash,
        blockNumber: r.block_number === null ? null : Number(r.block_number),
        polygonscanUrl: explorerTxUrl(r.tx_hash),
        status: r.status,
        logCount: r.log_count,
        sealedAt: new Date(r.sealed_at),
        confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
        // ผลจำแนก Isolation Forest (ระดับที่ 3) — null = ยังไม่ได้จำแนก
        ifAnomaly: r.if_anomaly,
        ifScore: r.if_score,
        ifReason: r.if_reason,
        ifScoredAt: r.if_scored_at ? new Date(r.if_scored_at) : null,
        hasSnapshot: r.has_snapshot,
      })),
      total,
      limit,
      offset,
    };
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
