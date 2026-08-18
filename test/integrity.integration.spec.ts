import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { IntegrityService } from '../src/integrity/integrity.service';
import { BlockchainService } from '../src/blockchain/blockchain.service';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';

const TEST_SOURCE = 'e2e-integrity';
const ZERO_ROOT = '0x' + '0'.repeat(64);

/**
 * Fake blockchain — เก็บ root ไว้ใน Map แทน smart contract
 * chainMap ถูก expose ออกมาให้เทสจำลอง chain reset / tamper ได้
 */
const chainMap = new Map<string, string>();
let blockCounter = 1000;

function normalizeRoot(root: string): string {
  return (root.startsWith('0x') ? root : '0x' + root).toLowerCase();
}

const fakeBlockchain = {
  ready: true,

  async storeRoot(batchId: string, merkleRoot: string) {
    chainMap.set(batchId.toLowerCase(), normalizeRoot(merkleRoot));
    blockCounter += 1;
    return {
      txHash: '0x' + blockCounter.toString(16).padStart(64, 'a'),
      blockNumber: blockCounter,
    };
  },

  async getRoot(batchId: string) {
    return {
      root: chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT,
      timestamp: 0,
    };
  },

  async verifyRoot(batchId: string, merkleRoot: string) {
    return (chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT) === normalizeRoot(merkleRoot);
  },

  /** เลียนแบบ logic จริงของ BlockchainService.checkRoot */
  async checkRoot(
    batchId: string,
    merkleRoot: string,
  ): Promise<{ result: 'MATCH' | 'MISSING' | 'MISMATCH'; onChainRoot: string }> {
    const onChainRoot = chainMap.get(batchId.toLowerCase()) ?? ZERO_ROOT;
    if (/^0x0+$/.test(onChainRoot)) {
      return { result: 'MISSING', onChainRoot };
    }
    return {
      result: onChainRoot === normalizeRoot(merkleRoot) ? 'MATCH' : 'MISMATCH',
      onChainRoot,
    };
  },
};

describe('Integrity Integration', () => {
  let app: INestApplication;
  let integrity: IntegrityService;
  let dataSource: DataSource;

  // state ที่ส่งต่อกันระหว่าง it()
  const logIds: string[] = [];
  const createdBatchIds: string[] = [];
  let batchId: string;
  let sealedMerkleRoot: string;

  // snapshot ของ batch ที่มีอยู่ก่อนเทส — restore ใน afterAll
  let preExistingBatches: Array<{
    id: string;
    status: string;
    tx_hash: string | null;
    block_number: string | null;
  }> = [];

  const prevAutoReanchor = process.env.INTEGRITY_AUTO_REANCHOR;

  beforeAll(async () => {
    // ต้องตั้งก่อน compile — reanchorUnverified() อ่าน process.env ตรงๆ
    process.env.INTEGRITY_AUTO_REANCHOR = 'true';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = {
            sub: 'e2e-integrity',
            preferred_username: 'e2e',
            roles: ['admin', 'analyst', 'ingestor'],
          };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({
        canActivate: () => true,
      })
      .overrideProvider(KafkaProducerService)
      .useValue({ publishLog: async () => undefined })
      .overrideProvider(KafkaConsumerService)
      .useValue({})
      .overrideProvider(BlockchainService)
      .useValue(fakeBlockchain)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
    await app.init();

    integrity = app.get(IntegrityService);
    dataSource = app.get(DataSource);

    // หยุด cron ทั้งหมด — ไม่ให้ scheduler มา seal/verify แทรกกลางเทส
    try {
      const registry = app.get(SchedulerRegistry);
      for (const [name, job] of registry.getCronJobs()) {
        await job.stop();
        registry.deleteCronJob(name);
      }
    } catch {
      // ไม่มี scheduler ก็ข้ามไป
    }

    // จำสถานะ batch เดิมไว้ แล้ว seed root ลง fake chain
    // (เทสนี้ verify ทุก batch ใน DB — ไม่ seed จะทำให้ของเดิมกลายเป็น UNVERIFIED)
    preExistingBatches = await dataSource.query(
      'SELECT id, status, tx_hash, block_number FROM batches',
    );
    const roots: Array<{ id: string; merkle_root: string }> = await dataSource.query(
      "SELECT id, merkle_root FROM batches WHERE status <> 'FAILED' AND status <> 'PENDING'",
    );
    for (const b of roots) {
      chainMap.set(b.id.toLowerCase(), normalizeRoot(b.merkle_root));
    }

    // ระบาย(drain) log ที่ยัง pending อยู่ก่อน เพื่อให้ batch ของเทสมีแต่ log ของเทส
    for (let i = 0; i < 50; i++) {
      const drained = await integrity.sealBatch();
      if (!drained) break;
      createdBatchIds.push(drained.id);
    }
  });

  afterAll(async () => {
    try {
      // คืนสถานะ batch เดิมที่ถูก verify/re-anchor ระหว่างเทส
      for (const b of preExistingBatches) {
        await dataSource.query(
          'UPDATE batches SET status = $2, tx_hash = $3, block_number = $4 WHERE id = $1',
          [b.id, b.status, b.tx_hash, b.block_number],
        );
      }

      let triggerDisabled = false;
      try {
        await dataSource.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_delete');
        triggerDisabled = true;
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.warn(
          `[integrity.integration] cannot disable trg_logs_no_delete (${err.message}) — skip deleting logs`,
        );
      }

      if (createdBatchIds.length > 0) {
        // ลบตามลำดับ FK: mapping -> alerts -> batches
        await dataSource.query('DELETE FROM log_batch_mapping WHERE batch_id = ANY($1)', [
          createdBatchIds,
        ]);
        await dataSource.query('DELETE FROM alerts WHERE batch_id = ANY($1)', [createdBatchIds]);
        await dataSource.query('DELETE FROM batches WHERE id = ANY($1)', [createdBatchIds]);
      }

      if (logIds.length > 0) {
        await dataSource.query('DELETE FROM alerts WHERE log_id = ANY($1)', [logIds]);
      }

      if (triggerDisabled) {
        try {
          await dataSource.query('DELETE FROM logs WHERE source = $1', [TEST_SOURCE]);
        } finally {
          await dataSource.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
        }
      }
    } catch (err: any) {
      // afterAll ต้องไม่ throw — ไม่งั้น suite แดงทั้งที่เทสผ่าน
      // eslint-disable-next-line no-console
      console.warn(`[integrity.integration] cleanup failed: ${err.message}`);
    } finally {
      if (process.env.INTEGRITY_AUTO_REANCHOR !== prevAutoReanchor) {
        if (prevAutoReanchor === undefined) delete process.env.INTEGRITY_AUTO_REANCHOR;
        else process.env.INTEGRITY_AUTO_REANCHOR = prevAutoReanchor;
      }
      await app.close();
    }
  });

  const countTamperAlerts = async (): Promise<number> => {
    const rows = await dataSource.query(
      "SELECT COUNT(*)::int AS c FROM alerts WHERE alert_type = 'INTEGRITY_TAMPERED'",
    );
    return rows[0].c;
  };

  const getBatch = async (id: string) => {
    const rows = await dataSource.query(
      'SELECT id, status, merkle_root, tx_hash FROM batches WHERE id = $1',
      [id],
    );
    return rows[0];
  };

  // 1
  it('ingests 3 logs via POST /logs', async () => {
    const messages = [
      'Failed login attempt #1 from console',
      'Failed login attempt #2 from console',
      'Failed login attempt #3 from console',
    ];

    for (const message of messages) {
      const res = await request(app.getHttpServer())
        .post('/api/v1/logs')
        .send({
          source: TEST_SOURCE,
          eventType: 'AUTH_FAILURE',
          severity: 'WARNING',
          classification: 'INTERNAL',
          message,
        })
        .expect(201);

      expect(res.body).toHaveProperty('id');
      expect(res.body.source).toBe(TEST_SOURCE);
      logIds.push(res.body.id);
    }

    expect(logIds).toHaveLength(3);
  });

  // 2
  it('seals a CONFIRMED batch covering all pending logs', async () => {
    const pendingRows = await dataSource.query(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT l.id FROM logs l
         LEFT JOIN log_batch_mapping m ON m.log_id = l.id
         WHERE m.log_id IS NULL
         ORDER BY l.created_at ASC, l.id ASC
         LIMIT 100
       ) t`,
    );
    const pendingCount: number = pendingRows[0].c;
    expect(pendingCount).toBeGreaterThanOrEqual(3);

    const batch = await integrity.sealBatch();
    expect(batch).not.toBeNull();
    batchId = batch!.id;
    sealedMerkleRoot = batch!.merkleRoot;
    createdBatchIds.push(batchId);

    expect(batch!.status).toBe('CONFIRMED');
    expect(batch!.logCount).toBe(pendingCount);
    expect(batch!.txHash).toBeTruthy();

    const mappingRows = await dataSource.query(
      'SELECT COUNT(*)::int AS c FROM log_batch_mapping WHERE batch_id = $1',
      [batchId],
    );
    expect(mappingRows[0].c).toBe(pendingCount);

    // log ทั้ง 3 ตัวของเทสต้องอยู่ใน batch นี้
    const mappedTestLogs = await dataSource.query(
      'SELECT COUNT(*)::int AS c FROM log_batch_mapping WHERE batch_id = $1 AND log_id = ANY($2)',
      [batchId, logIds],
    );
    expect(mappedTestLogs[0].c).toBe(3);
  });

  // 3
  it('GET /logs/:id/proof returns a verifiable proof', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/logs/${logIds[0]}/proof`)
      .expect(200);

    expect(res.body.logId).toBe(logIds[0]);
    expect(res.body.verify).toBe(true);
    expect(res.body.batch.id).toBe(batchId);
    expect(res.body.batch.status).toBe('CONFIRMED');
    expect(res.body.batch.txHash).not.toBeNull();
    expect(res.body.batch.merkleRoot).toBe(sealedMerkleRoot);
  });

  // 4
  it('verifyAllBatches is idempotent — batch stays CONFIRMED', async () => {
    await integrity.verifyAllBatches();
    expect((await getBatch(batchId)).status).toBe('CONFIRMED');

    await integrity.verifyAllBatches();
    expect((await getBatch(batchId)).status).toBe('CONFIRMED');
  });

  // 5
  it('chain reset marks the batch UNVERIFIED without raising a tamper alert', async () => {
    const alertsBefore = await countTamperAlerts();

    chainMap.clear();
    await integrity.verifyAllBatches();

    const batch = await getBatch(batchId);
    expect(batch.status).toBe('UNVERIFIED');
    expect(batch.status).not.toBe('TAMPERED');

    const alertsAfter = await countTamperAlerts();
    expect(alertsAfter).toBe(alertsBefore);

    const mine = await dataSource.query(
      "SELECT COUNT(*)::int AS c FROM alerts WHERE alert_type = 'INTEGRITY_TAMPERED' AND batch_id = $1",
      [batchId],
    );
    expect(mine[0].c).toBe(0);
  });

  // 6
  it('auto re-anchors the original root and returns to CONFIRMED', async () => {
    await integrity.reanchorUnverified();

    // re-anchor ต้องใช้ root เดิมจาก DB ไม่ใช่ recompute
    expect(chainMap.get(batchId.toLowerCase())).toBe(normalizeRoot(sealedMerkleRoot));

    await integrity.verifyAllBatches();

    const batch = await getBatch(batchId);
    expect(batch.status).toBe('CONFIRMED');
    expect(batch.merkle_root).toBe(sealedMerkleRoot);
    expect(chainMap.get(batchId.toLowerCase())).toBe(normalizeRoot(batch.merkle_root));
  });

  // 7
  it('detects tampering — batch TAMPERED + INTEGRITY_TAMPERED alert', async () => {
    chainMap.set(batchId.toLowerCase(), '0x' + 'ff'.repeat(32));

    await integrity.verifyAllBatches();

    const batch = await getBatch(batchId);
    expect(batch.status).toBe('TAMPERED');

    const alerts = await dataSource.query(
      "SELECT alert_type, severity, source, status FROM alerts WHERE batch_id = $1 AND alert_type = 'INTEGRITY_TAMPERED'",
      [batchId],
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('CRITICAL');
    expect(alerts[0].source).toBe('INTEGRITY');
    expect(alerts[0].status).toBe('OPEN');
  });
});
