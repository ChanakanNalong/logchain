import { Test, TestingModule } from '@nestjs/testing';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AuthGuard } from '@nestjs/passport';
import { randomBytes, randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { IntegrityService } from '../src/integrity/integrity.service';
import { BlockchainService } from '../src/blockchain/blockchain.service';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';
import { computeRawHash } from '../src/logs/services/log-hash';
import { deleteSnapshotsOf } from './snapshot-cleanup';

/**
 * feature/tamper-diff กับ Postgres จริง (environment hh) + chain ปลอม
 *   seal 100 log → snapshot ครบ 100 ตำแหน่ง · แก้ message ตำแหน่ง 55 → diff ชี้ถูก · แก้ + คำนวณ raw_hash ใหม่
 *   → ยังจับได้ · ลบตำแหน่ง 55 → DELETED พร้อมเนื้อเดิม · แก้ snapshot → untrusted
 *   · snapshot เขียนไม่ได้ = mapping ไม่ถูกเขียน (transaction จริง) · GET /batches แบ่งหน้า · role
 */

const RUN = randomBytes(3).toString('hex');
const SOURCE = `e2e-diff-${RUN}`;
const ZERO_ROOT = '0x' + '0'.repeat(64);

const chainMap = new Map<string, string>();
let block = 9000;
let rpcDown = false;
const norm = (r: string) => (r.startsWith('0x') ? r : '0x' + r).toLowerCase();

const fakeBlockchain = {
  ready: true,
  storeRoot(batchId: string, root: string) {
    chainMap.set(batchId.toLowerCase(), norm(root));
    block += 1;
    return Promise.resolve({
      txHash: '0x' + block.toString(16).padStart(64, 'c'),
      blockNumber: block,
      confirmed: true,
    });
  },
  getRoot(batchId: string) {
    if (rpcDown) return Promise.reject(new Error('connect ECONNREFUSED'));
    return Promise.resolve({
      root: chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT,
      timestamp: 0,
    });
  },
  checkRoot(batchId: string, root: string) {
    const onChainRoot = chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT;
    return Promise.resolve({
      result: onChainRoot === norm(root) ? 'MATCH' : 'MISMATCH',
      onChainRoot,
    });
  },
};

class HeaderRolesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const h = req.headers['x-test-roles'];
    if (h === undefined) throw new UnauthorizedException();
    req.user = {
      userId: 'e2e-tamper-diff',
      username: 'e2e-diff',
      roles: h.split(',').filter(Boolean),
    };
    return true;
  }
}

interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}
interface DiffBody {
  batchId: string;
  chainRoot: string | null;
  chainError: string | null;
  snapshotRoot: string | null;
  dbRoot: string;
  storedHashRoot: string | null;
  snapshotTrusted: boolean | null;
  trustBasis: string | null;
  untrustedReasons: string[];
  legacy: boolean;
  summary: Record<string, unknown> & { verdict: string };
  changes: Array<{
    position: number;
    logId: string;
    type: string;
    reason?: string;
    fields?: FieldChange[];
    snapshot?: Record<string, unknown>;
  }>;
}

interface LogRow {
  id: string;
  source: string;
  source_id: string | null;
  event_type: string;
  severity: string;
  message: string;
  raw_hash: string;
  classification: string;
  retention_days: number;
  cde_scope: boolean;
  created_at: Date;
}

describe('Tamper diff (integration)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let integrity: IntegrityService;
  const createdBatchIds: string[] = [];
  let batchId: string;
  /** log ที่ตำแหน่ง 55 ของ batch */
  let target: LogRow;
  const prevEnv = {
    SEAL_BATCH_SIZE: process.env.SEAL_BATCH_SIZE,
    SEAL_MIN_BALANCE_TX: process.env.SEAL_MIN_BALANCE_TX,
  };

  const http = () => app.getHttpServer() as App;
  const get = (path: string, roles = 'admin') =>
    request(http()).get(path).set({ 'x-test-roles': roles });
  const diff = async (roles = 'admin') =>
    (await get(`/api/v1/batches/${batchId}/diff`, roles).expect(200))
      .body as DiffBody;

  /** แก้ logs ตรง ๆ แบบคนที่ยึด DB ได้ (ปิด trigger ชั่วคราว) */
  const asAttacker = async (sql: string, params: unknown[]) => {
    await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update');
    try {
      await ds.query(sql, params);
    } finally {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update');
    }
  };
  const restoreTarget = () =>
    asAttacker('UPDATE logs SET message = $2, raw_hash = $3 WHERE id = $1', [
      target.id,
      target.message,
      target.raw_hash,
    ]);

  const sealAll = async () => {
    for (let i = 0; i < 50; i++) {
      const b = await integrity.sealBatch();
      if (!b) break;
      createdBatchIds.push(b.id);
    }
  };

  beforeAll(async () => {
    process.env.SEAL_BATCH_SIZE = '100';
    process.env.SEAL_MIN_BALANCE_TX = '0';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useClass(HeaderRolesGuard)
      .overrideProvider(KafkaProducerService)
      .useValue({ publishLog: () => Promise.resolve() })
      .overrideProvider(KafkaConsumerService)
      .useValue({ getHealth: () => ({ connected: true }) })
      .overrideProvider(BlockchainService)
      .useValue(fakeBlockchain)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    ds = app.get(DataSource);
    integrity = app.get(IntegrityService);

    const registry = app.get(SchedulerRegistry);
    for (const [name, job] of registry.getCronJobs()) {
      await job.stop();
      registry.deleteCronJob(name);
    }
    await sealAll(); // log ค้างของคนอื่นไปก่อน
  });

  afterAll(async () => {
    try {
      await ds.query(
        'ALTER TABLE batch_log_snapshot DROP CONSTRAINT IF EXISTS e2e_fail_snapshot',
      );
      await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_delete');
      try {
        if (createdBatchIds.length) {
          await ds.query(
            'DELETE FROM log_batch_mapping WHERE batch_id = ANY($1)',
            [createdBatchIds],
          );
          await ds.query('DELETE FROM alerts WHERE batch_id = ANY($1)', [
            createdBatchIds,
          ]);
          await deleteSnapshotsOf(ds, createdBatchIds);
          await ds.query('DELETE FROM batches WHERE id = ANY($1)', [
            createdBatchIds,
          ]);
        }
        await ds.query(
          'DELETE FROM log_batch_mapping WHERE log_id IN (SELECT id FROM logs WHERE source = $1)',
          [SOURCE],
        );
        await ds.query('DELETE FROM logs WHERE source = $1', [SOURCE]);
      } finally {
        await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
      }
    } catch (err) {
      console.warn(`[tamper-diff] cleanup failed: ${(err as Error).message}`);
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await app.close();
    }
  });

  it('seals 100 logs with a snapshot of every position', async () => {
    for (let i = 0; i < 100; i++) {
      await request(http())
        .post('/api/v1/logs')
        .set({ 'x-test-roles': 'ingestor' })
        .send({
          source: SOURCE,
          sourceIp: i % 3 ? '203.0.113.5' : undefined,
          eventType: 'SYSLOG',
          severity: 'WARNING',
          message: `Failed password for root from 203.0.113.xxx port ${52000 + i} ssh2`,
        })
        .expect(201);
    }
    await sealAll();
    const rows: Array<{ batch_id: string; n: string; max: number }> =
      await ds.query(
        `SELECT m.batch_id, COUNT(*) AS n FROM log_batch_mapping m
           JOIN logs l ON l.id = m.log_id WHERE l.source = $1 GROUP BY m.batch_id`,
        [SOURCE],
      );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n)).toBe(100);
    batchId = rows[0].batch_id;

    const snap: Array<{ n: string; lo: number; hi: number }> = await ds.query(
      `SELECT COUNT(*) AS n, MIN(position) AS lo, MAX(position) AS hi
         FROM batch_log_snapshot WHERE batch_id = $1`,
      [batchId],
    );
    expect(snap[0]).toEqual({ n: '100', lo: 0, hi: 99 });

    target = (
      await ds.query(
        `SELECT l.* FROM batch_log_snapshot s JOIN logs l ON l.id = s.log_id
          WHERE s.batch_id = $1 AND s.position = 55`,
        [batchId],
      )
    )[0];
    expect(target.source).toBe(SOURCE);
  });

  it('every snapshot recomputes to its raw_hash (jsonb key order does not matter)', async () => {
    const rows: Array<{ snapshot: Record<string, unknown>; raw_hash: string }> =
      await ds.query(
        'SELECT snapshot, raw_hash FROM batch_log_snapshot WHERE batch_id = $1',
        [batchId],
      );
    for (const r of rows) {
      const c = r.snapshot as unknown as Parameters<
        typeof computeRawHash
      >[0] & {
        createdAt: string;
      };
      expect(computeRawHash({ ...c, createdAt: new Date(c.createdAt) })).toBe(
        r.raw_hash,
      );
    }
  });

  it('snapshot rows are write-only', async () => {
    await expect(
      ds.query(
        `UPDATE batch_log_snapshot SET position = position WHERE batch_id = $1`,
        [batchId],
      ),
    ).rejects.toThrow(/IMMUTABLE_SNAPSHOT/);
    await expect(
      ds.query(`DELETE FROM batch_log_snapshot WHERE batch_id = $1`, [batchId]),
    ).rejects.toThrow(/IMMUTABLE_SNAPSHOT/);
  });

  it('intact: INTACT, trusted against the chain', async () => {
    const d = await diff();
    expect(d.snapshotTrusted).toBe(true);
    expect(d.trustBasis).toBe('chain');
    expect(d.chainRoot).toBe(d.snapshotRoot);
    expect(d.summary).toMatchObject({ verdict: 'INTACT', unchanged: 100 });
    expect(d.changes).toEqual([]);
  });

  it('message at position 55 edited → CONTENT_MODIFIED with before/after', async () => {
    await asAttacker('UPDATE logs SET message = $2 WHERE id = $1', [
      target.id,
      'user jdoe opened the reports page',
    ]);
    try {
      const d = await diff();
      expect(d.summary.verdict).toBe('TAMPERED');
      expect(d.changes).toEqual([
        {
          position: 55,
          logId: target.id,
          type: 'CONTENT_MODIFIED',
          fields: [
            {
              field: 'message',
              before: target.message,
              after: 'user jdoe opened the reports page',
            },
          ],
        },
      ]);
    } finally {
      await restoreTarget();
    }
  });

  it('message edited and raw_hash recomputed to match → still caught at 55 (root mismatch)', async () => {
    const forged = {
      id: target.id,
      source: target.source,
      sourceIp: target.source_id,
      eventType: target.event_type,
      severity: target.severity,
      message: 'nothing to see here',
      classification: target.classification,
      cdeScope: target.cde_scope,
      createdAt: new Date(target.created_at),
    };
    await asAttacker(
      'UPDATE logs SET message = $2, raw_hash = $3 WHERE id = $1',
      [target.id, forged.message, computeRawHash(forged)],
    );
    try {
      const d = await diff();
      expect(d.storedHashRoot).not.toBe(d.chainRoot);
      expect(d.snapshotTrusted).toBe(true);
      expect(d.changes.map((c) => [c.position, c.type])).toEqual([
        [55, 'CONTENT_MODIFIED'],
      ]);
      expect(d.changes[0].fields?.map((f) => f.field)).toEqual([
        'message',
        'rawHash',
      ]);
    } finally {
      await restoreTarget();
    }
  });

  it('snapshot itself edited → untrusted, batch level only', async () => {
    await ds.query(
      'ALTER TABLE batch_log_snapshot DISABLE TRIGGER trg_snapshot_no_update',
    );
    try {
      await ds.query(
        `UPDATE batch_log_snapshot SET snapshot = jsonb_set(snapshot, '{message}', '"forged"')
          WHERE batch_id = $1 AND position = 55`,
        [batchId],
      );
      const d = await diff();
      expect(d.snapshotTrusted).toBe(false);
      expect(d.untrustedReasons).toEqual(['SNAPSHOT_CONTENT_MISMATCH']);
      expect(d.changes).toEqual([]);
    } finally {
      await ds.query(
        `UPDATE batch_log_snapshot SET snapshot = jsonb_set(snapshot, '{message}', to_jsonb($2::text))
          WHERE batch_id = $1 AND position = 55`,
        [batchId, target.message],
      );
      await ds.query(
        'ALTER TABLE batch_log_snapshot ENABLE TRIGGER trg_snapshot_no_update',
      );
    }
    expect((await diff()).snapshotTrusted).toBe(true);
  });

  it('RPC down: still 200, basis db, chainError set', async () => {
    rpcDown = true;
    try {
      const d = await diff('auditor');
      expect(d.chainRoot).toBeNull();
      expect(d.chainError).toContain('ECONNREFUSED');
      expect(d.trustBasis).toBe('db');
      expect(d.summary.verdict).toBe('UNVERIFIABLE');
    } finally {
      rpcDown = false;
    }
  });

  it('position 55 deleted → DELETED with the original content', async () => {
    await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_delete');
    try {
      await ds.query('DELETE FROM log_batch_mapping WHERE log_id = $1', [
        target.id,
      ]);
      await ds.query('DELETE FROM logs WHERE id = $1', [target.id]);
    } finally {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
    }
    const d = await diff();
    expect(d.summary).toMatchObject({
      verdict: 'TAMPERED',
      deleted: 1,
      mappedLogs: 99,
    });
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]).toMatchObject({
      position: 55,
      logId: target.id,
      type: 'DELETED',
      reason: 'ROW_MISSING',
      snapshot: {
        id: target.id,
        message: target.message,
        rawHash: target.raw_hash,
        source: SOURCE,
      },
    });
  });

  it('a snapshot that cannot be written leaves no mapping (real transaction)', async () => {
    await request(http())
      .post('/api/v1/logs')
      .set({ 'x-test-roles': 'ingestor' })
      .send({ source: SOURCE, eventType: 'SYSLOG', message: 'tx probe' })
      .expect(201);
    // จำลอง insert snapshot ล้ม — CHECK ที่ไม่มีแถวไหนผ่าน (NOT VALID = ไม่ตรวจแถวเดิม)
    await ds.query(
      'ALTER TABLE batch_log_snapshot ADD CONSTRAINT e2e_fail_snapshot CHECK (false) NOT VALID',
    );
    let failedBatch: { id: string; status: string } | null = null;
    try {
      const b = await integrity.sealBatch(); // anchor ผ่าน → commit ล้ม → catch → FAILED
      if (b) {
        createdBatchIds.push(b.id);
        failedBatch = b;
      }
    } finally {
      await ds.query(
        'ALTER TABLE batch_log_snapshot DROP CONSTRAINT e2e_fail_snapshot',
      );
    }
    expect(failedBatch?.status).toBe('FAILED');
    const mapped: Array<{ n: string }> = await ds.query(
      'SELECT COUNT(*) AS n FROM log_batch_mapping WHERE batch_id = $1',
      [failedBatch!.id],
    );
    expect(mapped[0].n).toBe('0');
    // log ยังค้างอยู่ → seal ใหม่สำเร็จพร้อม snapshot
    await sealAll();
    const pending: Array<{ n: string }> = await ds.query(
      `SELECT COUNT(*) AS n FROM logs l
        WHERE l.source = $1 AND NOT EXISTS (SELECT 1 FROM log_batch_mapping m WHERE m.log_id = l.id)`,
      [SOURCE],
    );
    expect(pending[0].n).toBe('0');
  });

  describe('GET /batches', () => {
    it('returns a page with hasSnapshot and filters by status', async () => {
      const all = (await get('/api/v1/batches?limit=5', 'auditor').expect(200))
        .body as {
        items: Array<{ id: string; hasSnapshot: boolean; status: string }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(all.limit).toBe(5);
      expect(all.offset).toBe(0);
      expect(all.total).toBeGreaterThanOrEqual(3);
      expect(all.items.length).toBeLessThanOrEqual(5);

      const failed = (
        await get('/api/v1/batches?status=FAILED&limit=100', 'analyst')
      ).body as {
        items: Array<{ id: string; status: string; hasSnapshot: boolean }>;
      };
      expect(failed.items.every((b) => b.status === 'FAILED')).toBe(true);
      const ours = failed.items.find((b) => createdBatchIds.includes(b.id));
      expect(ours?.hasSnapshot).toBe(false);

      const mine = (
        await get(
          '/api/v1/batches?status=confirmed,tampered&limit=100',
          'operator',
        )
      ).body as { items: Array<{ id: string; hasSnapshot: boolean }> };
      expect(mine.items.find((b) => b.id === batchId)?.hasSnapshot).toBe(true);
    });

    it('400 on bad paging', async () => {
      await get('/api/v1/batches?limit=101').expect(400);
      await get('/api/v1/batches?offset=-1').expect(400);
    });
  });

  describe('diff roles / errors', () => {
    it.each([
      ['admin', 200],
      ['auditor', 200],
      ['analyst', 403],
      ['operator', 403],
      ['ingestor', 403],
    ])('%s → %d', async (role, code) => {
      await get(`/api/v1/batches/${batchId}/diff`, role).expect(code);
    });

    it('404 unknown, 400 non-UUID, 401 no token', async () => {
      await get(`/api/v1/batches/${randomUUID()}/diff`).expect(404);
      await get('/api/v1/batches/abc/diff').expect(400);
      await request(http()).get(`/api/v1/batches/${batchId}/diff`).expect(401);
    });

    it('a batch without snapshot is legacy', async () => {
      const legacy: Array<{ id: string }> = await ds.query(
        `SELECT b.id FROM batches b
          WHERE b.status <> 'FAILED'
            AND NOT EXISTS (SELECT 1 FROM batch_log_snapshot s WHERE s.batch_id = b.id)
          LIMIT 1`,
      );
      if (!legacy.length) return; // DB ใหม่ที่ไม่มี batch เก่า — ข้าม
      const d = (await get(`/api/v1/batches/${legacy[0].id}/diff`).expect(200))
        .body as DiffBody;
      expect(d.legacy).toBe(true);
      expect(d.snapshotRoot).toBeNull();
      expect(d.changes).toEqual([]);
    });
  });
});
