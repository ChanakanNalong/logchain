import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { BatchLogSnapshot } from './entities/batch-log-snapshot.entity';
import { MerkleService } from './service/merkle.service';
import { IntegrityService } from './integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { readChainRoot, isZeroRoot } from '../blockchain/chain-read';
import { explorerTxUrl } from '../blockchain/explorer';
import {
  isRawHashIntact,
  rawHashCanonical,
  recomputeContentLeaf,
  RawHashCanonical,
  RAW_HASH_VERSION,
} from '../logs/services/log-hash';

/** field ที่อยู่ใน raw_hash — เทียบทีละตัว (ลำดับเดียวกับ log-hash.ts) */
const COMPARED_FIELDS = [
  'source',
  'sourceIp',
  'eventType',
  'severity',
  'message',
  'classification',
  'cdeScope',
  'createdAt',
] as const;

export type ChangeType =
  | 'CONTENT_MODIFIED'
  | 'HASH_MODIFIED'
  | 'DELETED'
  | 'UNMAPPED_OR_INSERTED';

export interface LogContent {
  id: string;
  createdAt: string;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  classification: string;
  cdeScope: boolean;
  rawHash: string;
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type BatchChange =
  | {
      position: number;
      logId: string;
      type: 'CONTENT_MODIFIED' | 'HASH_MODIFIED';
      fields: FieldChange[];
    }
  | {
      position: number;
      logId: string;
      type: 'DELETED';
      reason: 'ROW_MISSING' | 'MAPPING_MISSING';
      snapshot: LogContent;
    }
  | {
      position: number;
      logId: string;
      type: 'UNMAPPED_OR_INSERTED';
      current: LogContent;
    };

export interface BatchDiff {
  batchId: string;
  status: string;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
  chainRoot: string | null;
  chainError: string | null;
  snapshotRoot: string | null;
  dbRoot: string;
  /** root จาก leaf = raw_hash ที่เก็บไว้ (จับการแก้คอลัมน์ raw_hash) — เดิมชื่อ currentRoot */
  storedHashRoot: string | null;
  /** root จาก leaf = hash คำนวณใหม่จากเนื้อหาปัจจุบัน (จับการแก้เนื้อ log) */
  contentRoot: string | null;
  snapshotTrusted: boolean | null;
  trustBasis: 'chain' | 'db' | null;
  untrustedReasons: Array<
    'SNAPSHOT_ROOT_MISMATCH' | 'SNAPSHOT_CONTENT_MISMATCH' | 'NOT_ANCHORED'
  >;
  legacy: boolean;
  checkedAt: Date;
  summary: {
    verdict: 'INTACT' | 'TAMPERED' | 'UNVERIFIABLE';
    snapshotLogs: number;
    mappedLogs: number;
    unchanged: number | null;
    contentModified: number | null;
    hashModified: number | null;
    deleted: number | null;
    unmappedOrInserted: number | null;
  };
  changes: BatchChange[];
}

/** status ที่ยังไม่ขึ้น chain ได้ (ไม่มี tx) — FAILED ไม่มี mapping โดยตั้งใจ (integrity.service.ts) */
const PRE_ANCHOR_STATUSES = new Set(['FAILED', 'SEALED', 'PENDING']);

const hex = (root: string) => ('0x' + root.replace(/^0x/, '')).toLowerCase();

/** สำเนาของ log สำหรับ response — snapshot กับ log ปัจจุบันใช้รูปเดียวกัน */
function content(c: RawHashCanonical, rawHash: string): LogContent {
  return {
    id: c.id,
    createdAt: c.createdAt,
    source: c.source,
    sourceIp: c.sourceIp,
    eventType: c.eventType,
    severity: c.severity,
    message: c.message,
    classification: c.classification,
    cdeScope: c.cdeScope,
    rawHash,
  };
}

/**
 * GET /batches/:id/diff — log ตำแหน่งไหนของ batch ถูกแก้ / ลบ / แทรก
 * สัญญา JSON + ลำดับการตรวจ: docs/api/batches-diff.md ข้อ 2
 *
 * snapshot ถูกเชื่อก็ต่อเมื่อ (1) root ที่สร้างจาก raw_hash ของ snapshot = root อ้างอิง (chain ถ้าอ่านได้
 * และ anchor แล้ว ไม่งั้น batches.merkle_root) และ (2) เนื้อทุกตัว hash ได้ raw_hash ของมันเอง
 * ไม่ผ่าน = บอกได้แค่ระดับ batch (currentRoot เทียบ root อ้างอิง) · Merkle / hash ใช้ตัวเดียวกับ seal + verify
 */
@Injectable()
export class BatchDiffService {
  constructor(
    @InjectRepository(Batch) private readonly batchesRepo: Repository<Batch>,
    @InjectRepository(Log) private readonly logsRepo: Repository<Log>,
    @InjectRepository(BatchLogSnapshot)
    private readonly snapshotRepo: Repository<BatchLogSnapshot>,
    private readonly merkle: MerkleService,
    private readonly integrity: IntegrityService,
    private readonly blockchain: BlockchainService,
  ) {}

  async diff(batchId: string): Promise<BatchDiff> {
    const batch = await this.batchesRepo.findOneBy({ id: batchId });
    if (!batch) throw new NotFoundException('Batch not found');

    const [snapshots, current, chain] = await Promise.all([
      this.snapshotRepo.find({
        where: { batchId },
        order: { position: 'ASC' },
      }),
      this.integrity.getLogsForBatch(batchId),
      readChainRoot(this.blockchain, batchId),
    ]);

    const dbRoot = hex(batch.merkleRoot);
    const chainRoot = 'root' in chain ? chain.root : null;
    const chainError = 'error' in chain ? chain.error : null;
    const storedHashRoot = current.length
      ? hex(this.merkle.buildTree(current.map((l) => l.rawHash)).root)
      : null;
    // leaf คำนวณใหม่จากเนื้อหาปัจจุบัน (version-aware) — เนื้อถูกแก้ → ต่างจาก storedHashRoot
    const contentRoot = current.length
      ? hex(
          this.merkle.buildTree(current.map((l) => recomputeContentLeaf(l)))
            .root,
        )
      : null;

    // root อ้างอิง: chain ถ้าอ่านได้และ anchor แล้ว (root ไม่ใช่ศูนย์) · ไม่งั้น root ใน DB
    const anchoredOnChain = chainRoot !== null && !isZeroRoot(chainRoot);
    const reference = anchoredOnChain ? chainRoot : dbRoot;
    // tx ส่งไปแล้วแต่อ่าน chain ไม่ได้ = root ใน DB อาจถูกแก้ตามได้ ยืนยันไม่ได้
    const unverifiable = chainError !== null && !!batch.txHash;
    // ไม่มี tx + ไม่มี root บน chain = ไม่มีอะไรอ้างอิงนอก DB → UNVERIFIABLE ไม่ใช่ TAMPERED
    // (batch FAILED ไม่มี log ผูก → currentRoot null ≠ dbRoot เสมอ = TAMPERED ปลอม)
    // changes ยังคำนวณให้ดู แต่เทียบกับ DB ล้วน ตัดสินไม่ได้
    const notAnchored =
      !batch.txHash &&
      PRE_ANCHOR_STATUSES.has(batch.status) &&
      !anchoredOnChain;
    const settle = (d: BatchDiff): BatchDiff =>
      notAnchored
        ? {
            ...d,
            untrustedReasons: [...d.untrustedReasons, 'NOT_ANCHORED'],
            summary: { ...d.summary, verdict: 'UNVERIFIABLE' },
          }
        : d;

    const base = {
      batchId: batch.id,
      status: batch.status,
      txHash: batch.txHash ?? null,
      blockNumber:
        batch.blockNumber === null ? null : Number(batch.blockNumber),
      polygonscanUrl: explorerTxUrl(batch.txHash),
      chainRoot,
      chainError,
      dbRoot,
      storedHashRoot,
      contentRoot,
      checkedAt: new Date(),
    };
    const batchLevelVerdict = () =>
      storedHashRoot === reference &&
      contentRoot === reference &&
      dbRoot === reference
        ? unverifiable
          ? 'UNVERIFIABLE'
          : 'INTACT'
        : 'TAMPERED';
    const unknownCounts = {
      unchanged: null,
      contentModified: null,
      hashModified: null,
      deleted: null,
      unmappedOrInserted: null,
    };

    // ── legacy: seal ก่อนมี snapshot ─────────────────────────
    if (snapshots.length === 0) {
      return settle({
        ...base,
        snapshotRoot: null,
        snapshotTrusted: null,
        trustBasis: null,
        untrustedReasons: [],
        legacy: true,
        summary: {
          verdict: batchLevelVerdict(),
          snapshotLogs: 0,
          mappedLogs: current.length,
          ...unknownCounts,
        },
        changes: [],
      });
    }

    // ── 1-3: พิสูจน์ snapshot ก่อนเชื่อ ───────────────────────
    const snapshotRoot = hex(
      this.merkle.buildTree(snapshots.map((s) => s.rawHash)).root,
    );
    const untrustedReasons: BatchDiff['untrustedReasons'] = [];
    if (snapshotRoot !== reference)
      untrustedReasons.push('SNAPSHOT_ROOT_MISMATCH');
    if (!snapshots.every((s) => this.snapshotIntact(s))) {
      untrustedReasons.push('SNAPSHOT_CONTENT_MISMATCH');
    }
    const trusted = untrustedReasons.length === 0;
    const trustBasis = anchoredOnChain ? 'chain' : 'db';

    if (!trusted) {
      return settle({
        ...base,
        snapshotRoot,
        snapshotTrusted: false,
        trustBasis,
        untrustedReasons,
        legacy: false,
        summary: {
          // snapshot ถูกแก้แล้ว = มีคนแตะ DB แน่ ๆ
          verdict: 'TAMPERED',
          snapshotLogs: snapshots.length,
          mappedLogs: current.length,
          ...unknownCounts,
        },
        changes: [],
      });
    }

    // ── 4: เทียบทีละตำแหน่ง ──────────────────────────────────
    const mappedById = new Map(current.map((l) => [l.id, l]));
    const snapshotIds = new Set(snapshots.map((s) => s.logId));
    const missing = snapshots
      .map((s) => s.logId)
      .filter((id) => !mappedById.has(id));
    // row ยังอยู่แต่ไม่ได้ผูกกับ batch แล้ว = MAPPING_MISSING (ไม่ใช่ ROW_MISSING)
    const stillThere = new Set(
      missing.length
        ? (
            await this.logsRepo.find({
              select: { id: true },
              where: { id: In(missing) },
            })
          ).map((l) => l.id)
        : [],
    );

    const changes: BatchChange[] = [];
    let unchanged = 0;
    for (const s of snapshots) {
      const now = mappedById.get(s.logId);
      if (!now) {
        changes.push({
          position: s.position,
          logId: s.logId,
          type: 'DELETED',
          reason: stillThere.has(s.logId) ? 'MAPPING_MISSING' : 'ROW_MISSING',
          snapshot: content(s.snapshot, s.rawHash),
        });
        continue;
      }
      const after = rawHashCanonical(now);
      const fields: FieldChange[] = COMPARED_FIELDS.filter(
        (f) => s.snapshot[f] !== after[f],
      ).map((f) => ({ field: f, before: s.snapshot[f], after: after[f] }));
      const hashChanged = now.rawHash !== s.rawHash;
      if (hashChanged) {
        fields.push({
          field: 'rawHash',
          before: s.rawHash,
          after: now.rawHash,
        });
      }
      if (fields.length === 0) {
        unchanged++;
      } else {
        changes.push({
          position: s.position,
          logId: s.logId,
          type:
            fields.length === 1 && hashChanged
              ? 'HASH_MODIFIED'
              : 'CONTENT_MODIFIED',
          fields,
        });
      }
    }
    current.forEach((l, index) => {
      if (snapshotIds.has(l.id)) return;
      changes.push({
        position: index,
        logId: l.id,
        type: 'UNMAPPED_OR_INSERTED',
        current: content(rawHashCanonical(l), l.rawHash),
      });
    });
    changes.sort((a, b) => a.position - b.position);

    const count = (t: ChangeType) => changes.filter((c) => c.type === t).length;
    const intact =
      changes.length === 0 &&
      storedHashRoot === reference &&
      contentRoot === reference &&
      dbRoot === reference;
    return settle({
      ...base,
      snapshotRoot,
      snapshotTrusted: true,
      trustBasis,
      untrustedReasons: [],
      legacy: false,
      summary: {
        verdict: !intact
          ? 'TAMPERED'
          : unverifiable
            ? 'UNVERIFIABLE'
            : 'INTACT',
        snapshotLogs: snapshots.length,
        mappedLogs: current.length,
        unchanged,
        contentModified: count('CONTENT_MODIFIED'),
        hashModified: count('HASH_MODIFIED'),
        deleted: count('DELETED'),
        unmappedOrInserted: count('UNMAPPED_OR_INSERTED'),
      },
      changes,
    });
  }

  /** เนื้อใน snapshot ยัง hash ได้ raw_hash ที่เก็บไว้ไหม (รับ hash v1 ของ log เก่าด้วย เหมือน verify) */
  private snapshotIntact(s: BatchLogSnapshot): boolean {
    const c = s.snapshot;
    if (c.v !== RAW_HASH_VERSION || c.id !== s.logId) return false;
    const createdAt = new Date(c.createdAt);
    if (Number.isNaN(createdAt.getTime())) return false;
    return isRawHashIntact({ ...c, createdAt, rawHash: s.rawHash });
  }
}
