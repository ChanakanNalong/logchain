import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Batch } from '../logs/entities/batch.entity';
import { BatchLogSnapshot } from './entities/batch-log-snapshot.entity';
import { recomputeContentLeaf } from '../logs/services/log-hash';
import { MerkleService } from './service/merkle.service';
import { IntegrityService } from './integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { readChainRoot } from '../blockchain/chain-read';
import { explorerTxUrl } from '../blockchain/explorer';
import {
  Dec,
  divInt,
  formatDec,
  fromUnits,
  mul,
  mulInt,
  parseDec,
} from '../common/decimal';

/** ค่าเดียวกันสามมุม: ต่อ batch · ต่อ log · ถ้า anchor ทีละ log */
export interface CostTriple {
  batch: string;
  perLog: string;
  oneTxPerLog: string;
}

export interface BatchCost {
  gasUsed: string;
  effectiveGasPriceGwei: string;
  batchCostPol: string;
  perLogCostPol: string;
  oneTxPerLogCostPol: string;
  savingFactor: string;
  /** มูลค่า POL แปลงเป็น ETH ตามราคาตลาด (PRICE_POL_ETH) — ไม่ใช่ gas บน Ethereum */
  eth: CostTriple | null;
  thb: CostTriple | null;
  rates: {
    polEth: string | null;
    polThb: string | null;
    asOf: string | null;
    source: 'config';
  };
}

export interface BatchTree {
  batchId: string;
  status: string;
  logCount: number;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  dbRoot: string;
  /** root จาก snapshot ที่เก็บตอน seal · null = batch เก่าก่อนมี snapshot */
  snapshotRoot: string | null;
  /** root จาก leaf = raw_hash ที่เก็บไว้ (เดิมชื่อ computedRoot) — จับการแก้คอลัมน์ raw_hash */
  storedHashRoot: string | null;
  storedHashRootMatchesDb: boolean;
  /** root จาก leaf = hash คำนวณใหม่จากเนื้อหาปัจจุบัน — จับการแก้เนื้อ log */
  contentRoot: string | null;
  contentRootMatchesDb: boolean;
  chainRoot: string | null;
  chainError: string | null;
  checkedAt: Date;
  leaves: Array<{
    index: number;
    logId: string;
    rawHash: string;
    leafHash: string;
    /** hash คำนวณใหม่จากเนื้อหาปัจจุบัน (ต่างจาก rawHash = เนื้อถูกแก้) */
    contentHash: string;
  }>;
  layers: string[][];
  promoted: Array<{ layer: number; index: number }>;
  cost: BatchCost | null;
}

const POL_DECIMALS = 18;
const GWEI_DECIMALS = 9;

/**
 * GET /batches/:id/tree — Merkle tree ทุกชั้น + ค่าใช้จ่ายของ batch · สัญญา JSON: docs/api/merkle-tree.md
 * tree มาจาก MerkleService.getLayers (merkletreejs) บน log ที่ผูกกับ batch ตามลำดับ leaf เดียวกับ verify
 */
@Injectable()
export class BatchTreeService {
  private readonly logger = new Logger(BatchTreeService.name);

  constructor(
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    private readonly merkle: MerkleService,
    private readonly integrity: IntegrityService,
    private readonly blockchain: BlockchainService,
  ) {}

  async tree(batchId: string): Promise<BatchTree> {
    const batch = await this.batchesRepo.findOneBy({ id: batchId });
    if (!batch) throw new NotFoundException('Batch not found');

    const [logs, chain, snapshots] = await Promise.all([
      this.integrity.getLogsForBatch(batchId),
      readChainRoot(this.blockchain, batchId),
      this.batchesRepo.manager
        .getRepository(BatchLogSnapshot)
        .find({ where: { batchId }, order: { position: 'ASC' } }),
    ]);

    const dbRoot = ('0x' + batch.merkleRoot.replace(/^0x/, '')).toLowerCase();
    const snapshotRoot = snapshots.length
      ? this.merkle
          .buildTree(snapshots.map((s) => s.rawHash))
          .root.toLowerCase()
      : null;
    // layers ที่โชว์ = tree จาก raw_hash ที่เก็บไว้ (storedHashRoot) เหมือนเดิม
    const built = logs.length
      ? this.merkle.getLayers(logs.map((l) => l.rawHash))
      : null;
    const storedHashRoot = built ? built.root.toLowerCase() : null;
    const contentRoot = logs.length
      ? this.merkle
          .buildTree(logs.map((l) => recomputeContentLeaf(l)))
          .root.toLowerCase()
      : null;

    return {
      batchId: batch.id,
      status: batch.status,
      logCount: batch.logCount,
      txHash: batch.txHash ?? null,
      blockNumber:
        batch.blockNumber === null ? null : Number(batch.blockNumber),
      polygonscanUrl: explorerTxUrl(batch.txHash),
      dbRoot,
      snapshotRoot,
      storedHashRoot,
      storedHashRootMatchesDb: storedHashRoot === dbRoot,
      contentRoot,
      contentRootMatchesDb: contentRoot === dbRoot,
      chainRoot: 'root' in chain ? chain.root : null,
      chainError: 'error' in chain ? chain.error : null,
      checkedAt: new Date(),
      leaves: logs.map((l, index) => ({
        index,
        logId: l.id,
        rawHash: l.rawHash,
        leafHash: this.merkle.leafHash(l.rawHash),
        contentHash: recomputeContentLeaf(l),
      })),
      layers: built?.layers ?? [],
      promoted: built?.promoted ?? [],
      cost: this.cost(batch),
    };
  }

  /** null ถ้าไม่มี gas_used (ไม่มี tx / ยังไม่ backfill) · ทุกค่าเป็นทศนิยม exact */
  private cost(batch: Batch): BatchCost | null {
    if (batch.gasUsed == null || batch.effectiveGasPrice == null) return null;
    const logCount = BigInt(Math.max(batch.logCount, 1));
    const wei = BigInt(batch.gasUsed) * BigInt(batch.effectiveGasPrice);

    const pol = fromUnits(wei, POL_DECIMALS);
    const perLog = divInt(pol, logCount);
    const oneTxPerLog = mulInt(pol, logCount);
    const triple = (rate: Dec | null): CostTriple | null =>
      rate
        ? {
            batch: formatDec(mul(pol, rate)),
            perLog: formatDec(mul(perLog, rate)),
            oneTxPerLog: formatDec(mul(oneTxPerLog, rate)),
          }
        : null;

    const rate = (key: 'PRICE_POL_ETH' | 'PRICE_POL_THB') => {
      const raw = process.env[key];
      const d = parseDec(raw);
      if (raw?.trim() && !d) {
        this.logger.warn(`${key}="${raw}" is not a positive decimal — ignored`);
      }
      return d;
    };
    const polEth = rate('PRICE_POL_ETH');
    const polThb = rate('PRICE_POL_THB');

    return {
      gasUsed: batch.gasUsed,
      effectiveGasPriceGwei: formatDec(
        fromUnits(BigInt(batch.effectiveGasPrice), GWEI_DECIMALS),
      ),
      batchCostPol: formatDec(pol),
      perLogCostPol: formatDec(perLog),
      oneTxPerLogCostPol: formatDec(oneTxPerLog),
      savingFactor: logCount.toString(),
      eth: triple(polEth),
      thb: triple(polThb),
      rates: {
        polEth: polEth ? formatDec(polEth) : null,
        polThb: polThb ? formatDec(polThb) : null,
        asOf: process.env.PRICE_AS_OF?.trim() || null,
        source: 'config',
      },
    };
  }
}
