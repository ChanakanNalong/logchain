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
import { deleteSnapshotsOf } from './snapshot-cleanup';

/**
 * GET /batches/:id/tree กับ Postgres จริง (environment hh) + chain ปลอม
 *   root จาก layers = merkle_root ของ **ทุก batch** ใน DB · 1 log · จำนวนคี่ · 100 log
 *   · proof leafIndex/leafHash ตรงกับ tree · cost (มี/ไม่มี gas) · RPC ล่ม · role
 */

const RUN = randomBytes(3).toString('hex');
const SOURCE = `e2e-tree-${RUN}`;
const ZERO_ROOT = '0x' + '0'.repeat(64);

const chainMap = new Map<string, string>();
let block = 12000;
let rpcDown = false;
let withGas = true;
const norm = (r: string) => (r.startsWith('0x') ? r : '0x' + r).toLowerCase();

const fakeBlockchain = {
  ready: true,
  storeRoot(batchId: string, root: string) {
    chainMap.set(batchId.toLowerCase(), norm(root));
    block += 1;
    return Promise.resolve({
      txHash: '0x' + block.toString(16).padStart(64, 'd'),
      blockNumber: block,
      confirmed: true,
      gasUsed: withGas ? 78156n : null,
      effectiveGasPrice: withGas ? 30_000_000_000n : null,
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
      userId: 'e2e-merkle-tree',
      username: 'e2e-tree',
      roles: h.split(',').filter(Boolean),
    };
    return true;
  }
}

interface TreeBody {
  batchId: string;
  logCount: number;
  dbRoot: string;
  storedHashRoot: string | null;
  storedHashRootMatchesDb: boolean;
  chainRoot: string | null;
  chainError: string | null;
  leaves: Array<{
    index: number;
    logId: string;
    rawHash: string;
    leafHash: string;
  }>;
  layers: string[][];
  promoted: Array<{ layer: number; index: number }>;
  cost: null | {
    gasUsed: string;
    batchCostPol: string;
    perLogCostPol: string;
    savingFactor: string;
  };
}

describe('Merkle tree API (integration)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let integrity: IntegrityService;
  const createdBatchIds: string[] = [];
  const prevEnv = {
    SEAL_BATCH_SIZE: process.env.SEAL_BATCH_SIZE,
    SEAL_MIN_BALANCE_TX: process.env.SEAL_MIN_BALANCE_TX,
  };

  const http = () => app.getHttpServer() as App;
  const get = (path: string, roles = 'analyst') =>
    request(http()).get(path).set({ 'x-test-roles': roles });
  const tree = async (id: string) =>
    (await get(`/api/v1/batches/${id}/tree`).expect(200)).body as TreeBody;

  const sealAll = async () => {
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const b = await integrity.sealBatch();
      if (!b) break;
      createdBatchIds.push(b.id);
      ids.push(b.id);
    }
    return ids;
  };
  /** ingest n log แล้ว seal เป็น batch เดียว */
  const sealOf = async (n: number): Promise<string> => {
    for (let i = 0; i < n; i++) {
      await request(http())
        .post('/api/v1/logs')
        .set({ 'x-test-roles': 'ingestor' })
        .send({
          source: SOURCE,
          eventType: 'SYSLOG',
          message: `tree ${n}/${i}`,
        })
        .expect(201);
    }
    const ids = await sealAll();
    expect(ids).toHaveLength(1);
    return ids[0];
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
    await sealAll();
  });

  afterAll(async () => {
    try {
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
        await ds.query('DELETE FROM logs WHERE source = $1', [SOURCE]);
      } finally {
        await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
      }
    } catch (err) {
      console.warn(`[merkle-tree] cleanup failed: ${(err as Error).message}`);
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await app.close();
    }
  });

  let one: string;
  let odd: string;
  let hundred: string;

  it('seals batches of 1, 7 and 100 logs', async () => {
    one = await sealOf(1);
    odd = await sealOf(7);
    hundred = await sealOf(100);
  });

  it('root from layers = merkle_root for every batch with logs in the DB', async () => {
    const batches: Array<{ id: string; merkle_root: string }> = await ds.query(
      `SELECT b.id, b.merkle_root FROM batches b
        WHERE EXISTS (SELECT 1 FROM log_batch_mapping m WHERE m.batch_id = b.id)`,
    );
    expect(batches.length).toBeGreaterThanOrEqual(3);
    for (const b of batches) {
      const t = await tree(b.id);
      const top = t.layers[t.layers.length - 1];
      expect(top).toEqual(['0x' + b.merkle_root]);
      expect(t.storedHashRootMatchesDb).toBe(true);
      expect(t.leaves).toHaveLength(t.layers[0].length);
    }
  });

  it('1 log: single layer, root = its leafHash', async () => {
    const t = await tree(one);
    expect(t.layers).toHaveLength(1);
    expect(t.layers[0][0]).toBe(t.leaves[0].leafHash);
    expect(t.promoted).toEqual([]);
  });

  it('7 logs: odd node promoted at each odd layer', async () => {
    const t = await tree(odd);
    expect(t.layers.map((l) => l.length)).toEqual([7, 4, 2, 1]);
    expect(t.promoted).toEqual([{ layer: 0, index: 6 }]);
    expect(t.layers[1][3]).toBe(t.layers[0][6]);
  });

  it('100 logs: 8 layers, leaves in createdAt/id order, cost with gas', async () => {
    const t = await tree(hundred);
    expect(t.layers.map((l) => l.length)).toEqual([
      100, 50, 25, 13, 7, 4, 2, 1,
    ]);
    const order: Array<{ id: string }> = await ds.query(
      `SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id = l.id
        WHERE m.batch_id = $1 ORDER BY l.created_at, l.id`,
      [hundred],
    );
    expect(t.leaves.map((l) => l.logId)).toEqual(order.map((r) => r.id));
    expect(t.chainRoot).toBe(t.dbRoot);
    expect(t.cost).toMatchObject({
      gasUsed: '78156',
      batchCostPol: '0.00234468',
      perLogCostPol: '0.0000234468',
      savingFactor: '100',
    });
  });

  it('proof leafIndex / leafHash match the tree', async () => {
    const t = await tree(odd);
    for (const leaf of [t.leaves[0], t.leaves[6]]) {
      const p = (await get(`/api/v1/logs/${leaf.logId}/proof`).expect(200))
        .body as {
        leafIndex: number;
        leafHash: string;
        rawHash: string;
        verify: boolean;
      };
      expect(p.leafIndex).toBe(leaf.index);
      expect(p.leafHash).toBe(leaf.leafHash);
      expect(p.rawHash).toBe(leaf.rawHash);
      expect(p.verify).toBe(true);
    }
  });

  it('no gas_used → cost null', async () => {
    withGas = false;
    try {
      const id = await sealOf(2);
      expect((await tree(id)).cost).toBeNull();
    } finally {
      withGas = true;
    }
  });

  it('RPC down: chainRoot null + chainError, still 200', async () => {
    rpcDown = true;
    try {
      const t = await tree(hundred);
      expect(t.chainRoot).toBeNull();
      expect(t.chainError).toContain('ECONNREFUSED');
      expect(t.storedHashRootMatchesDb).toBe(true);
    } finally {
      rpcDown = false;
    }
  });

  it('roles and errors', async () => {
    for (const role of ['analyst', 'operator', 'auditor', 'admin']) {
      await get(`/api/v1/batches/${one}/tree`, role).expect(200);
    }
    await get(`/api/v1/batches/${one}/tree`, 'ingestor').expect(403);
    await request(http()).get(`/api/v1/batches/${one}/tree`).expect(401);
    await get(`/api/v1/batches/${randomUUID()}/tree`).expect(404);
    await get('/api/v1/batches/nope/tree').expect(400);
  });
});
