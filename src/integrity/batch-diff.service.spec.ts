import { NotFoundException } from '@nestjs/common';
import { In, Repository } from 'typeorm';
import { BatchDiffService } from './batch-diff.service';
import { MerkleService } from './service/merkle.service';
import { IntegrityService } from './integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';
import { BatchLogSnapshot } from './entities/batch-log-snapshot.entity';
import { computeRawHash, rawHashCanonical } from '../logs/services/log-hash';

/**
 * diff ของ batch เทียบกับ snapshot ตอน seal — ทุกชนิดของการเปลี่ยน + snapshot ไม่น่าเชื่อ + legacy + RPC ล่ม
 * MerkleService / log-hash ตัวจริง (ห้าม mock hashing)
 */

const BATCH = 'c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c';
const id = (n: number) =>
  `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const merkle = new MerkleService();
const ZERO = '0x' + '0'.repeat(64);

function makeLog(n: number): Log {
  const row = {
    id: id(n),
    source: 'vps-01',
    sourceIp: n % 2 ? '203.0.113.5' : null,
    eventType: 'SYSLOG',
    severity: 'WARNING',
    message: `Failed password for root from 203.0.113.xxx port ${52300 + n} ssh2`,
    classification: 'INTERNAL',
    cdeScope: false,
    createdAt: new Date(Date.UTC(2026, 9, 15, 9, 0, n)),
    retentionDays: 365,
  };
  return { ...row, rawHash: computeRawHash(row) };
}

const rootOf = (logs: Array<{ rawHash: string }>) =>
  merkle.buildTree(logs.map((l) => l.rawHash)).root.toLowerCase();

interface World {
  sealed: Log[];
  /** log ปัจจุบันที่ผูกกับ batch (ลำดับ leaf) */
  current: Log[];
  /** row ใน logs ทั้งหมด (รวมที่ถูกถอด mapping) */
  rows: Log[];
  snapshots: BatchLogSnapshot[];
  batch: Partial<Batch>;
  chain: { ready: boolean; getRoot: jest.Mock };
}

function world(n = 10): World {
  const sealed = Array.from({ length: n }, (_, i) => makeLog(i));
  const root = rootOf(sealed);
  const chainRoots = new Map([[BATCH, root]]);
  return {
    sealed,
    current: sealed.map((l) => ({ ...l })),
    rows: sealed.map((l) => ({ ...l })),
    snapshots: sealed.map((l, position) => ({
      batchId: BATCH,
      logId: l.id,
      position,
      snapshot: rawHashCanonical(l),
      rawHash: l.rawHash,
      createdAt: new Date(),
    })),
    batch: {
      id: BATCH,
      status: 'CONFIRMED',
      merkleRoot: root.replace(/^0x/, ''),
      txHash: '0xfbe0',
      blockNumber: '28451107' as unknown as number,
    },
    chain: {
      ready: true,
      getRoot: jest.fn((b: string) =>
        Promise.resolve({ root: chainRoots.get(b) ?? ZERO, timestamp: 1 }),
      ),
    },
  };
}

function service(w: World) {
  const find = (opts: { where: { id: ReturnType<typeof In> } }) => {
    const ids = opts.where.id.value as string[];
    return Promise.resolve(w.rows.filter((r) => ids.includes(r.id)));
  };
  return new BatchDiffService(
    {
      findOneBy: ({ id: bid }: { id: string }) =>
        Promise.resolve(bid === BATCH ? (w.batch as Batch) : null),
    } as unknown as Repository<Batch>,
    { find } as unknown as Repository<Log>,
    {
      find: () =>
        Promise.resolve(
          [...w.snapshots].sort((a, b) => a.position - b.position),
        ),
    } as unknown as Repository<BatchLogSnapshot>,
    merkle,
    {
      getLogsForBatch: () => Promise.resolve(w.current),
    } as unknown as IntegrityService,
    w.chain as unknown as BlockchainService,
  );
}

/** แก้ log ปัจจุบัน (เหมือนแก้ row ใน logs) */
function tamper(w: World, n: number, patch: Partial<Log>, rehash = false) {
  for (const list of [w.current, w.rows]) {
    const l = list.find((x) => x.id === id(n));
    if (!l) continue;
    Object.assign(l, patch);
    if (rehash) l.rawHash = computeRawHash(l);
  }
}

describe('BatchDiffService', () => {
  it('intact batch: verdict INTACT, trusted against the chain, no changes', async () => {
    const w = world();
    const d = await service(w).diff(BATCH);
    expect(d).toMatchObject({
      batchId: BATCH,
      status: 'CONFIRMED',
      blockNumber: 28451107,
      legacy: false,
      snapshotTrusted: true,
      trustBasis: 'chain',
      untrustedReasons: [],
      chainError: null,
      changes: [],
    });
    expect(d.chainRoot).toBe(d.snapshotRoot);
    // ไม่แก้อะไร → root ทั้งสองแบบเขียว
    expect(d.storedHashRoot).toBe(d.dbRoot);
    expect(d.contentRoot).toBe(d.dbRoot);
    expect(d.summary).toEqual({
      verdict: 'INTACT',
      snapshotLogs: 10,
      mappedLogs: 10,
      unchanged: 10,
      contentModified: 0,
      hashModified: 0,
      deleted: 0,
      unmappedOrInserted: 0,
    });
  });

  it('message edited (raw_hash left alone) → CONTENT_MODIFIED with before/after', async () => {
    const w = world();
    tamper(w, 5, { message: 'user jdoe opened the reports page' });
    const d = await service(w).diff(BATCH);
    expect(d.summary.verdict).toBe('TAMPERED');
    expect(d.changes).toEqual([
      {
        position: 5,
        logId: id(5),
        type: 'CONTENT_MODIFIED',
        fields: [
          {
            field: 'message',
            before: w.sealed[5].message,
            after: 'user jdoe opened the reports page',
          },
        ],
      },
    ]);
    // แก้ message: storedHashRoot ไม่เปลี่ยน (raw_hash เดิม) แต่ contentRoot แดง (คำนวณจากเนื้อหาใหม่)
    // = ประเด็นที่แก้: เดิม root เขียวทั้งที่เนื้อถูกแก้
    expect(d.storedHashRoot).toBe(d.chainRoot);
    expect(d.contentRoot).not.toBe(d.chainRoot);
  });

  it('message edited and raw_hash recomputed to match → still caught, rawHash in fields', async () => {
    const w = world();
    tamper(w, 5, { message: 'hacked' }, true);
    const d = await service(w).diff(BATCH);
    // แก้ทั้ง message + raw_hash → แดงทั้งสอง root
    expect(d.storedHashRoot).not.toBe(d.chainRoot);
    expect(d.contentRoot).not.toBe(d.chainRoot);
    expect(d.changes).toHaveLength(1);
    const c = d.changes[0];
    expect(c).toMatchObject({ position: 5, type: 'CONTENT_MODIFIED' });
    expect(
      c.type === 'CONTENT_MODIFIED' && c.fields.map((f) => f.field),
    ).toEqual(['message', 'rawHash']);
  });

  it('several fields at once (severity, sourceIp, createdAt)', async () => {
    const w = world();
    tamper(w, 3, {
      severity: 'INFO',
      sourceIp: '198.51.100.9',
      createdAt: new Date(Date.UTC(2026, 9, 15, 9, 0, 59)),
    });
    const d = await service(w).diff(BATCH);
    const c = d.changes[0];
    expect(c.type === 'CONTENT_MODIFIED' && c.fields).toEqual([
      { field: 'sourceIp', before: '203.0.113.5', after: '198.51.100.9' },
      { field: 'severity', before: 'WARNING', after: 'INFO' },
      {
        field: 'createdAt',
        before: '2026-10-15T09:00:03.000Z',
        after: '2026-10-15T09:00:59.000Z',
      },
    ]);
  });

  it('only raw_hash changed (demo-tamper) → HASH_MODIFIED', async () => {
    const w = world();
    tamper(w, 0, { rawHash: 'f'.repeat(64) });
    const d = await service(w).diff(BATCH);
    expect(d.changes).toEqual([
      {
        position: 0,
        logId: id(0),
        type: 'HASH_MODIFIED',
        fields: [
          {
            field: 'rawHash',
            before: w.sealed[0].rawHash,
            after: 'f'.repeat(64),
          },
        ],
      },
    ]);
    expect(d.summary.hashModified).toBe(1);
    // แก้แค่ raw_hash: storedHashRoot แดง · contentRoot เขียว (เนื้อหาเดิม) — เหมือนพฤติกรรมเดิม
    expect(d.storedHashRoot).not.toBe(d.chainRoot);
    expect(d.contentRoot).toBe(d.chainRoot);
  });

  it('row deleted → DELETED / ROW_MISSING with the sealed content', async () => {
    const w = world();
    w.current = w.current.filter((l) => l.id !== id(5));
    w.rows = w.rows.filter((l) => l.id !== id(5));
    const d = await service(w).diff(BATCH);
    expect(d.changes).toEqual([
      {
        position: 5,
        logId: id(5),
        type: 'DELETED',
        reason: 'ROW_MISSING',
        snapshot: {
          id: id(5),
          createdAt: '2026-10-15T09:00:05.000Z',
          source: 'vps-01',
          sourceIp: '203.0.113.5',
          eventType: 'SYSLOG',
          severity: 'WARNING',
          message: w.sealed[5].message,
          classification: 'INTERNAL',
          cdeScope: false,
          rawHash: w.sealed[5].rawHash,
        },
      },
    ]);
    expect(d.summary).toMatchObject({
      deleted: 1,
      mappedLogs: 9,
      unchanged: 9,
    });
  });

  it('mapping removed but row still there → DELETED / MAPPING_MISSING', async () => {
    const w = world();
    w.current = w.current.filter((l) => l.id !== id(2));
    const d = await service(w).diff(BATCH);
    expect(d.changes[0]).toMatchObject({
      position: 2,
      type: 'DELETED',
      reason: 'MAPPING_MISSING',
    });
  });

  it('a log mapped to the batch but not in the snapshot → UNMAPPED_OR_INSERTED', async () => {
    const w = world();
    const extra = makeLog(99);
    w.current.push(extra);
    w.rows.push(extra);
    const d = await service(w).diff(BATCH);
    expect(d.changes).toEqual([
      expect.objectContaining({
        position: 10,
        logId: id(99),
        type: 'UNMAPPED_OR_INSERTED',
        current: expect.objectContaining({
          id: id(99),
          rawHash: extra.rawHash,
        }),
      }),
    ]);
  });

  it('changes are sorted by position', async () => {
    const w = world();
    tamper(w, 7, { message: 'x' });
    tamper(w, 1, { rawHash: 'e'.repeat(64) });
    w.current = w.current.filter((l) => l.id !== id(4));
    const d = await service(w).diff(BATCH);
    expect(d.changes.map((c) => [c.position, c.type])).toEqual([
      [1, 'HASH_MODIFIED'],
      [4, 'DELETED'],
      [7, 'CONTENT_MODIFIED'],
    ]);
  });

  describe('untrusted snapshot', () => {
    it('snapshot content edited → SNAPSHOT_CONTENT_MISMATCH, batch level only', async () => {
      const w = world();
      w.snapshots[5].snapshot = {
        ...w.snapshots[5].snapshot,
        message: 'forged',
      };
      tamper(w, 5, { message: 'forged' });
      const d = await service(w).diff(BATCH);
      expect(d.snapshotTrusted).toBe(false);
      expect(d.untrustedReasons).toEqual(['SNAPSHOT_CONTENT_MISMATCH']);
      expect(d.changes).toEqual([]);
      expect(d.summary).toMatchObject({
        verdict: 'TAMPERED',
        unchanged: null,
        contentModified: null,
      });
    });

    it('snapshot raw_hash rewritten to match forged content → SNAPSHOT_ROOT_MISMATCH', async () => {
      const w = world();
      const forged = { ...w.snapshots[5].snapshot, message: 'forged' };
      w.snapshots[5].snapshot = forged;
      w.snapshots[5].rawHash = computeRawHash({
        ...forged,
        createdAt: new Date(forged.createdAt),
      });
      const d = await service(w).diff(BATCH);
      expect(d.snapshotTrusted).toBe(false);
      expect(d.untrustedReasons).toEqual(['SNAPSHOT_ROOT_MISMATCH']);
      expect(d.snapshotRoot).not.toBe(d.chainRoot);
    });

    it('snapshot id swapped → content mismatch', async () => {
      const w = world();
      w.snapshots[0].snapshot = { ...w.snapshots[0].snapshot, id: id(77) };
      const d = await service(w).diff(BATCH);
      expect(d.untrustedReasons).toContain('SNAPSHOT_CONTENT_MISMATCH');
    });
  });

  describe('legacy batch (no snapshot)', () => {
    it('intact → batch-level INTACT, counts unknown', async () => {
      const w = world();
      w.snapshots = [];
      const d = await service(w).diff(BATCH);
      expect(d).toMatchObject({
        legacy: true,
        snapshotRoot: null,
        snapshotTrusted: null,
        trustBasis: null,
        changes: [],
      });
      expect(d.summary).toMatchObject({
        verdict: 'INTACT',
        snapshotLogs: 0,
        mappedLogs: 10,
        unchanged: null,
      });
    });

    it('raw_hash changed → batch-level TAMPERED, no positions', async () => {
      const w = world();
      w.snapshots = [];
      tamper(w, 3, { rawHash: 'f'.repeat(64) });
      const d = await service(w).diff(BATCH);
      expect(d.summary.verdict).toBe('TAMPERED');
      expect(d.changes).toEqual([]);
    });
  });

  describe('chain', () => {
    it('RPC down: chainRoot null + chainError, trusts against the DB root, UNVERIFIABLE', async () => {
      const w = world();
      w.chain.getRoot.mockRejectedValue(new Error('ECONNREFUSED'));
      const d = await service(w).diff(BATCH);
      expect(d.chainRoot).toBeNull();
      expect(d.chainError).toContain('ECONNREFUSED');
      expect(d.trustBasis).toBe('db');
      expect(d.snapshotTrusted).toBe(true);
      expect(d.summary.verdict).toBe('UNVERIFIABLE');
    });

    it('RPC down but a change is found → still TAMPERED with the position', async () => {
      const w = world();
      w.chain.getRoot.mockRejectedValue(new Error('timeout'));
      tamper(w, 5, { message: 'x' });
      const d = await service(w).diff(BATCH);
      expect(d.summary.verdict).toBe('TAMPERED');
      expect(d.changes.map((c) => c.position)).toEqual([5]);
    });

    it('batches.merkle_root rewritten → TAMPERED even when logs look intact', async () => {
      const w = world();
      w.batch.merkleRoot = 'a'.repeat(64);
      const d = await service(w).diff(BATCH);
      expect(d.snapshotTrusted).toBe(true); // snapshot ผูกกับ chain ไม่ใช่ DB
      expect(d.summary.verdict).toBe('TAMPERED');
    });

    it('batches.merkle_root rewritten on a CONFIRMED legacy batch → still TAMPERED, no NOT_ANCHORED', async () => {
      const w = world();
      w.snapshots = [];
      w.batch.merkleRoot = 'b'.repeat(64);
      const d = await service(w).diff(BATCH);
      expect(d.summary.verdict).toBe('TAMPERED');
      expect(d.untrustedReasons).toEqual([]);
    });
  });

  describe('not anchored (no tx, nothing on chain)', () => {
    const unanchored = (w: World, status: string) => {
      w.batch.status = status;
      w.batch.txHash = null as unknown as string;
      w.batch.blockNumber = null;
      w.chain.getRoot.mockResolvedValue({ root: ZERO, timestamp: 0 });
    };

    it('FAILED with no mapping → UNVERIFIABLE / NOT_ANCHORED, not TAMPERED', async () => {
      const w = world();
      unanchored(w, 'FAILED');
      w.snapshots = [];
      w.current = [];
      const d = await service(w).diff(BATCH);
      expect(d.storedHashRoot).toBeNull();
      expect(d.contentRoot).toBeNull();
      expect(d.legacy).toBe(true);
      expect(d.polygonscanUrl).toBeNull();
      expect(d.untrustedReasons).toEqual(['NOT_ANCHORED']);
      expect(d.summary).toMatchObject({
        verdict: 'UNVERIFIABLE',
        snapshotLogs: 0,
        mappedLogs: 0,
      });
    });

    it('SEALED with no tx → UNVERIFIABLE / NOT_ANCHORED, basis db', async () => {
      const w = world();
      unanchored(w, 'SEALED');
      const d = await service(w).diff(BATCH);
      expect(d.trustBasis).toBe('db');
      expect(d.snapshotTrusted).toBe(true);
      expect(d.untrustedReasons).toEqual(['NOT_ANCHORED']);
      expect(d.summary.verdict).toBe('UNVERIFIABLE');
    });

    it('SEALED with no tx and an edited log → UNVERIFIABLE, change still listed', async () => {
      const w = world();
      unanchored(w, 'SEALED');
      tamper(w, 2, { message: 'x' });
      const d = await service(w).diff(BATCH);
      expect(d.summary.verdict).toBe('UNVERIFIABLE');
      expect(d.changes.map((c) => c.position)).toEqual([2]);
    });

    it('PENDING with no tx → UNVERIFIABLE / NOT_ANCHORED', async () => {
      const w = world();
      unanchored(w, 'PENDING');
      const d = await service(w).diff(BATCH);
      expect(d.untrustedReasons).toEqual(['NOT_ANCHORED']);
      expect(d.summary.verdict).toBe('UNVERIFIABLE');
    });

    it('no tx in DB but the root is on chain → anchored, normal verdict', async () => {
      const w = world();
      w.batch.status = 'SEALED';
      w.batch.txHash = null as unknown as string;
      const d = await service(w).diff(BATCH);
      expect(d.trustBasis).toBe('chain');
      expect(d.untrustedReasons).toEqual([]);
      expect(d.summary.verdict).toBe('INTACT');
    });
  });

  it('404 for an unknown batch', async () => {
    await expect(
      service(world()).diff('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
