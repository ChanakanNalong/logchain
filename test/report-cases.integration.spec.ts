import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { IntegrityService } from '../src/integrity/integrity.service';
import {
  MerkleService,
  MerkleProofItem,
} from '../src/integrity/service/merkle.service';
import { Batch } from '../src/logs/entities/batch.entity';
import { BlockchainService } from '../src/blockchain/blockchain.service';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';

/**
 * กรณีทดสอบในเล่มรายงาน (บทที่ 4) ที่ยังไม่มีเทสต์อัตโนมัติ — ชื่อ it() ขึ้นต้นด้วยรหัสกรณีทดสอบ
 * DB จริง + chain ปลอม (ไม่เสีย gas) · ลบ log / batch ของเทสต์ทิ้งใน afterAll แบบเดียวกับ
 * integrity.integration.spec.ts · ต้องหยุด backend ตัวจริงก่อนรัน ไม่งั้น cron ของมันอาจหยิบ log
 * ของเทสต์ไปปิด batch และ anchor ขึ้น chain จริง
 * REPORT_RESULTS_FILE=<path> เขียนตัวเลขที่วัดได้ลงไฟล์ (jest ซ่อน console ของ suite ที่ผ่าน)
 */
const TEST_SOURCE = 'e2e-report-cases';
const ZERO_ROOT = '0x' + '0'.repeat(64);
const chainMap = new Map<string, string>();
let blockCounter = 5000;
const norm = (r: string) => (r.startsWith('0x') ? r : '0x' + r).toLowerCase();

const fakeBlockchain = {
  ready: true,
  storeRoot(batchId: string, merkleRoot: string) {
    // เลียนแบบ require(roots[batchId] == 0, "Root already exists") ของ LogIntegrity.sol
    if (chainMap.has(batchId.toLowerCase()))
      return Promise.reject(new Error('Root already exists'));
    chainMap.set(batchId.toLowerCase(), norm(merkleRoot));
    blockCounter += 1;
    return Promise.resolve({
      txHash: '0x' + blockCounter.toString(16).padStart(64, 'a'),
      blockNumber: blockCounter,
      confirmed: true,
    });
  },
  getRoot(batchId: string) {
    return Promise.resolve({
      root: chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT,
      timestamp: 0,
    });
  },
  verifyRoot(batchId: string, merkleRoot: string) {
    return Promise.resolve(
      (chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT) === norm(merkleRoot),
    );
  },
  checkRoot(batchId: string, merkleRoot: string) {
    const onChainRoot = chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT;
    if (/^0x0+$/.test(onChainRoot))
      return Promise.resolve({ result: 'MISSING' as const, onChainRoot });
    return Promise.resolve({
      result:
        onChainRoot === norm(merkleRoot)
          ? ('MATCH' as const)
          : ('MISMATCH' as const),
      onChainRoot,
    });
  },
};

interface ProofBody {
  logId: string;
  rawHash: string;
  proof: MerkleProofItem[];
  verify: boolean;
}
interface BatchRow {
  id: string;
  status: string;
  tx_hash: string | null;
  block_number: string | null;
}
interface CountRow {
  c: number;
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean: +mean.toFixed(2),
    min: +s[0].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    p95: +s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)].toFixed(2),
  };
};

describe('Report test cases (chapter 4)', () => {
  let app: INestApplication;
  let integrity: IntegrityService;
  let merkle: MerkleService;
  let ds: DataSource;
  const logIds: string[] = [];
  const createdBatchIds: string[] = [];
  let preExisting: BatchRow[] = [];
  const results: Record<string, unknown> = {};

  /** query แบบมี type — ds.query คืน any */
  const sql = <T>(text: string, params?: unknown[]) =>
    ds.query<T[]>(text, params);
  const http = () => app.getHttpServer() as App;
  const count = async (text: string, params?: unknown[]) =>
    (await sql<CountRow>(text, params))[0].c;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user: unknown }>().user = {
            userId: 'e2e-report-cases',
            username: 'e2e-report',
            roles: ['admin', 'analyst', 'ingestor'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(KafkaProducerService)
      .useValue({ publishLog: () => Promise.resolve() })
      .overrideProvider(KafkaConsumerService)
      .useValue({})
      .overrideProvider(BlockchainService)
      .useValue(fakeBlockchain)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    // เหมือน main.ts — FT-13 ต้องการ validation จริง
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    integrity = app.get(IntegrityService);
    merkle = app.get(MerkleService);
    ds = app.get(DataSource);

    try {
      const registry = app.get(SchedulerRegistry);
      for (const [name, job] of registry.getCronJobs()) {
        await job.stop();
        registry.deleteCronJob(name);
      }
    } catch {
      // ไม่มี scheduler
    }

    preExisting = await sql<BatchRow>(
      'SELECT id, status, tx_hash, block_number FROM batches',
    );
    for (const b of await sql<{ id: string; merkle_root: string }>(
      "SELECT id, merkle_root FROM batches WHERE status NOT IN ('FAILED','PENDING')",
    )) {
      chainMap.set(b.id.toLowerCase(), norm(b.merkle_root));
    }
    // ระบาย log ที่ค้างอยู่ก่อน เพื่อให้แต่ละ batch ของเทสต์มีแต่ log ที่เทสต์ส่ง (คืนสภาพใน afterAll)
    for (let i = 0; i < 50; i++) {
      const drained = await integrity.sealBatch();
      if (!drained) break;
      createdBatchIds.push(drained.id);
    }
  });

  afterAll(async () => {
    try {
      for (const b of preExisting) {
        await ds.query(
          'UPDATE batches SET status=$2, tx_hash=$3, block_number=$4 WHERE id=$1',
          [b.id, b.status, b.tx_hash, b.block_number],
        );
      }
      await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_delete');
      try {
        // batch ของเทสต์ + batch ที่ผูกกับ log ของเทสต์ (เผื่อ IM-12 สร้างใบที่ไม่ได้อยู่ในรายการ)
        const viaLogs = await sql<{ batch_id: string }>(
          `SELECT DISTINCT m.batch_id FROM log_batch_mapping m JOIN logs l ON l.id = m.log_id WHERE l.source = $1`,
          [TEST_SOURCE],
        );
        const ids = [
          ...new Set([...createdBatchIds, ...viaLogs.map((r) => r.batch_id)]),
        ];
        if (ids.length) {
          await ds.query(
            'DELETE FROM log_batch_mapping WHERE batch_id = ANY($1)',
            [ids],
          );
          await ds.query('DELETE FROM alerts WHERE batch_id = ANY($1)', [ids]);
          await ds.query('DELETE FROM batches WHERE id = ANY($1)', [ids]);
        }
        await ds.query('DELETE FROM alerts WHERE log_id = ANY($1)', [logIds]);
        await ds.query('DELETE FROM logs WHERE source = $1', [TEST_SOURCE]);
      } finally {
        await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
      }
    } catch (err) {
      console.warn(`[report-cases] cleanup failed: ${(err as Error).message}`);
    } finally {
      if (process.env.REPORT_RESULTS_FILE) {
        writeFileSync(
          process.env.REPORT_RESULTS_FILE,
          JSON.stringify(results, null, 1),
        );
      }
      await app.close();
    }
  });

  const ingest = async (
    n: number,
    extra: Record<string, unknown> = {},
  ): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const res = await request(http())
        .post('/api/v1/logs')
        .send({
          source: TEST_SOURCE,
          eventType: 'AUTH_FAILURE',
          severity: 'WARNING',
          classification: 'INTERNAL',
          message: `report case log ${Date.now()}-${i}`,
          ...extra,
        })
        .expect(201);
      const { id } = res.body as { id: string };
      ids.push(id);
      logIds.push(id);
    }
    return ids;
  };

  const seal = async (): Promise<Batch> => {
    const b = await integrity.sealBatch();
    expect(b).not.toBeNull();
    createdBatchIds.push(b!.id);
    return b!;
  };

  const getProof = async (id: string): Promise<ProofBody> => {
    const res = await request(http())
      .get(`/api/v1/logs/${id}/proof`)
      .expect(200);
    return res.body as ProofBody;
  };

  const rawHashes = async (batchId: string): Promise<string[]> =>
    (
      await sql<{ raw_hash: string }>(
        `SELECT l.raw_hash FROM logs l JOIN log_batch_mapping m ON m.log_id = l.id
         WHERE m.batch_id = $1 ORDER BY l.created_at ASC, l.id ASC`,
        [batchId],
      )
    ).map((r) => r.raw_hash);

  const countLogs = () => count('SELECT COUNT(*)::int AS c FROM logs');

  it('FT-13 rejects a log with a missing required field or an invalid severity with 400 and stores nothing', async () => {
    const before = await countLogs();
    const missing = await request(http())
      .post('/api/v1/logs')
      .send({
        source: TEST_SOURCE,
        eventType: 'AUTH_FAILURE',
        severity: 'WARNING',
      }) // ไม่มี message
      .expect(400);
    const badSeverity = await request(http())
      .post('/api/v1/logs')
      .send({
        source: TEST_SOURCE,
        eventType: 'AUTH_FAILURE',
        severity: 'SUPER',
        message: 'x',
      })
      .expect(400);
    expect(await countLogs()).toBe(before);
    results['FT-13'] = {
      missing: missing.status,
      badSeverity: badSeverity.status,
      stored: 0,
    };
  });

  it('ST-13 writes an audit row with user, time and action for every mutating request', async () => {
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await ingest(3);
    await new Promise((r) => setTimeout(r, 500)); // audit เป็น fire-and-forget
    const rows = await sql<{
      action: string;
      status_code: number;
      accessed_at: Date;
    }>(
      `SELECT action, status_code, accessed_at FROM audit_access
       WHERE user_id = 'e2e-report-cases' AND accessed_at >= $1 AND method = 'POST' ORDER BY accessed_at`,
      [since],
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.action).toBe('POST /api/v1/logs');
      expect(r.status_code).toBe(201);
      expect(r.accessed_at).toBeTruthy();
    }
    results['ST-13'] = { requests: 3, auditRows: rows.length };
  });

  it('IM-11 seals a single-log batch whose root is the hashed leaf and whose empty proof verifies', async () => {
    const leftover = await integrity.sealBatch(); // ปิด log ของ ST-13 ออกไปก่อน
    if (leftover) createdBatchIds.push(leftover.id);
    const [id] = await ingest(1);
    const b = await seal();
    expect(b.logCount).toBe(1);
    const [leaf] = await rawHashes(b.id);
    const expected = createHash('sha256').update(leaf).digest('hex');
    expect(b.merkleRoot.replace(/^0x/, '')).toBe(expected);
    const body = await getProof(id);
    expect(body.proof).toEqual([]);
    expect(body.verify).toBe(true);
    results['IM-11'] = { logCount: 1, proofLength: 0, verify: true };
  });

  it('IM-10 seals a five-log batch and every proof verifies (odd node carried up, not duplicated)', async () => {
    const ids = await ingest(5);
    const b = await seal();
    expect(b.logCount).toBe(5);
    const lengths: number[] = [];
    for (const id of ids) {
      const body = await getProof(id);
      expect(body.verify).toBe(true);
      lengths.push(body.proof.length);
    }
    // 5 ใบ: 4 ใบแรกมี proof 3 ชั้น · ใบที่ 5 ถูกยกขึ้นไปจับคู่ชั้นบนสุดตรง ๆ = 1 ชั้น
    const { tree } = merkle.buildTree(await rawHashes(b.id));
    results['IM-10'] = {
      logCount: 5,
      allVerify: true,
      proofLengths: lengths,
      treeLayers: tree.getLayers().length,
    };
  });

  it('IM-09 rejects a proof from one batch checked against the root of another batch', async () => {
    const aIds = await ingest(4);
    const a = await seal();
    await ingest(4);
    const b = await seal();
    let falseAccepts = 0;
    let ownOk = 0;
    for (const id of aIds) {
      const body = await getProof(id);
      if (merkle.verifyProof(body.rawHash, body.proof, a.merkleRoot)) ownOk++;
      if (merkle.verifyProof(body.rawHash, body.proof, b.merkleRoot))
        falseAccepts++;
    }
    expect(ownOk).toBe(4);
    expect(falseAccepts).toBe(0);
    results['IM-09'] = {
      checked: 4,
      verifiedAgainstOwnRoot: ownOk,
      acceptedAgainstOtherRoot: falseAccepts,
    };
  });

  it('ST-14 does not create a new batch or overwrite the root when the same batch is anchored again', async () => {
    await ingest(2);
    const b = await seal();
    const countBatches = () => count('SELECT COUNT(*)::int AS c FROM batches');
    const batchesBefore = await countBatches();
    // ส่ง root ของ batch เดิมซ้ำ — contract ปฏิเสธ
    await expect(
      fakeBlockchain.storeRoot(b.id, '0x' + 'f'.repeat(64)),
    ).rejects.toThrow('Root already exists');
    expect(chainMap.get(b.id.toLowerCase())).toBe(norm(b.merkleRoot));
    // ไม่มี log ค้าง → ไม่เกิด batch ใหม่
    expect(await integrity.sealBatch()).toBeNull();
    expect(await countBatches()).toBe(batchesBefore);
    results['ST-14'] = { rejected: true, newBatches: 0 };
  });

  it('IM-12 seals several batches at the same moment without mapping any log twice', async () => {
    await ingest(6);
    const settled = await Promise.allSettled([
      integrity.sealBatch(),
      integrity.sealBatch(),
      integrity.sealBatch(),
    ]);
    const made: Batch[] = [];
    const errors: string[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) made.push(s.value);
      if (s.status === 'rejected') errors.push(String(s.reason));
    }
    made.forEach((b) => createdBatchIds.push(b.id));
    const duplicateMappings = await count(
      `SELECT COUNT(*)::int AS c FROM (SELECT log_id FROM log_batch_mapping GROUP BY log_id HAVING COUNT(*) > 1) t`,
    );
    const unmapped = await count(
      `SELECT COUNT(*)::int AS c FROM logs l LEFT JOIN log_batch_mapping m ON m.log_id = l.id
       WHERE l.source = $1 AND m.log_id IS NULL`,
      [TEST_SOURCE],
    );
    // batch ที่ถูกสร้างระหว่างเทสต์แต่ไม่มี log ผูก = batch ผี
    // (ยกเว้น batch เดิมใน DB — FAILED 2 ใบของ 2026-09-22 ไม่มี mapping โดยตั้งใจ ห้ามลบ)
    const orphanBatches = await sql<{
      id: string;
      status: string;
      log_count: number;
    }>(
      `SELECT b.id, b.status, b.log_count FROM batches b LEFT JOIN log_batch_mapping m ON m.batch_id = b.id
       WHERE m.batch_id IS NULL AND NOT (b.id = ANY($1))`,
      [preExisting.map((p) => p.id)],
    );
    orphanBatches.forEach((o) => createdBatchIds.push(o.id));
    results['IM-12'] = {
      calls: 3,
      batchesReturned: made.length,
      batchStatuses: made.map((b) => `${b.status}:${b.logCount}`),
      errors,
      duplicateMappings,
      unmappedTestLogs: unmapped,
      orphanBatches: orphanBatches.map((o) => `${o.status}:${o.log_count}`),
    };
    expect(duplicateMappings).toBe(0);
    expect(unmapped).toBe(0);
    expect(orphanBatches).toHaveLength(0);
  });

  it('PT-04 measures sealing a full 100-log batch (5 rounds)', async () => {
    const sealMs: number[] = [];
    const treeMs: number[] = [];
    for (let round = 0; round < 5; round++) {
      await ingest(100);
      const t0 = process.hrtime.bigint();
      const b = await seal();
      sealMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
      expect(b.logCount).toBe(100);
      const leaves = await rawHashes(b.id);
      const t1 = process.hrtime.bigint();
      merkle.buildTree(leaves);
      treeMs.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    results['PT-04'] = {
      sealBatchMs: stats(sealMs),
      merkleTreeOnlyMs: stats(treeMs),
    };
  });

  it('PT-06 measures GET /logs/:id/proof for every log of a 100-log batch', async () => {
    const ids = await ingest(100);
    await seal();
    const ms: number[] = [];
    for (const id of ids) {
      const t0 = process.hrtime.bigint();
      const body = await getProof(id);
      ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      expect(body.verify).toBe(true);
    }
    results['PT-06'] = { proofRequestMs: stats(ms) };
  });
});
