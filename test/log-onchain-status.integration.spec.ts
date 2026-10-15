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
import { AlertsService } from '../src/alerts/alerts.service';
import { explorerTxUrl } from '../src/blockchain/explorer';

/**
 * feature/log-onchain-status กับ Postgres จริง (environment hh)
 *   GET /logs แบ่งหน้า + filter + สถานะ batch · GET /logs/:id (404/400) · GET /logs/:id/detail
 *   (sealed / unsealed / RPC ล่ม) · 403 ตาม role · alert 2 IP แยกแถว · alert_logs ครบทุก role
 *
 * RolesGuard ตัวจริง · AuthGuard('jwt') ถูกแทนด้วย guard ที่อ่าน role จาก header x-test-roles
 * chain ปลอม (Map) — getRoot สลับให้พังได้เพื่อจำลอง RPC ล่ม
 */

const RUN = randomBytes(3).toString('hex');
const SRC_A = `e2e-los-a-${RUN}`;
const SRC_B = `e2e-los-b-${RUN}`;
const SOURCES = [SRC_A, SRC_B];
const ZERO_ROOT = '0x' + '0'.repeat(64);
const IP_A = '203.0.113.5';
const IP_B = '198.51.100.9';

const chainMap = new Map<string, string>();
let block = 5000;
let rpcDown = false;
const norm = (r: string) => (r.startsWith('0x') ? r : '0x' + r).toLowerCase();

const fakeBlockchain = {
  ready: true,
  storeRoot(batchId: string, root: string) {
    chainMap.set(batchId.toLowerCase(), norm(root));
    block += 1;
    return Promise.resolve({
      txHash: '0x' + block.toString(16).padStart(64, 'b'),
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

/** role จาก header — ไม่มี header = 401 */
class HeaderRolesGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: unknown;
    }>();
    const h = req.headers['x-test-roles'];
    if (h === undefined) throw new UnauthorizedException();
    req.user = {
      userId: 'e2e-log-onchain',
      username: 'e2e-los',
      roles: h.split(',').filter(Boolean),
    };
    return true;
  }
}

interface LogItem {
  id: string;
  source: string;
  severity: string;
  message: string;
  batchId: string | null;
  batchStatus: string | null;
  txHash: string | null;
  blockNumber: number | null;
  polygonscanUrl: string | null;
}
interface LogPageBody {
  items: LogItem[];
  total: number;
  limit: number;
  offset: number;
}

describe('Log on-chain status + alert_logs (integration)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let integrity: IntegrityService;
  let alerts: AlertsService;
  const createdBatchIds: string[] = [];
  const logIds: string[] = [];
  const prevEnv = {
    SEAL_BATCH_SIZE: process.env.SEAL_BATCH_SIZE,
    SEAL_MIN_BALANCE_TX: process.env.SEAL_MIN_BALANCE_TX,
  };

  const http = () => app.getHttpServer() as App;
  const as = (roles: string) => ({ 'x-test-roles': roles });
  const get = (path: string, roles = 'analyst') =>
    request(http()).get(path).set(as(roles));

  const ingest = async (body: Record<string, unknown>): Promise<string> => {
    const res = await request(http())
      .post('/api/v1/logs')
      .set(as('ingestor'))
      .send({ eventType: 'SYSLOG', severity: 'INFO', ...body })
      .expect(201);
    const id = (res.body as { id: string }).id;
    logIds.push(id);
    return id;
  };

  const seal = async () => {
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
    alerts = app.get(AlertsService);

    const registry = app.get(SchedulerRegistry);
    for (const [name, job] of registry.getCronJobs()) {
      await job.stop();
      registry.deleteCronJob(name);
    }

    // log ค้างของคนอื่นปิดไปก่อน — batch ของเทสจะได้มีแต่ log ของเทส
    await seal();
  });

  afterAll(async () => {
    try {
      await ds.query(
        `DELETE FROM alerts WHERE source = ANY($1) OR log_id = ANY($2::uuid[])`,
        [SOURCES, logIds],
      ); // alert_logs หายตาม (ON DELETE CASCADE)
      await ds.query(`DELETE FROM alert_logs WHERE log_id = ANY($1::uuid[])`, [
        logIds,
      ]);
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
          await ds.query('DELETE FROM batches WHERE id = ANY($1)', [
            createdBatchIds,
          ]);
        }
        await ds.query('DELETE FROM logs WHERE source = ANY($1)', [SOURCES]);
      } finally {
        await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
      }
    } catch (err) {
      console.warn(
        `[log-onchain-status] cleanup failed: ${(err as Error).message}`,
      );
    } finally {
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await app.close();
    }
  });

  // ── fixtures: 7 log บน 2 source ─────────────────────────────
  let sealedId: string;
  /** log ที่เกิดซ้ำหลัง seal — ยังไม่ถูก seal ตลอดเทส */
  let repeatId: string;
  const failIds: string[] = [];

  it('ingests the fixtures', async () => {
    for (let i = 0; i < 5; i++) {
      failIds.push(
        await ingest({
          source: SRC_A,
          sourceIp: IP_A,
          severity: 'WARNING',
          message: `Failed password for root from 203.0.113.5 port ${52300 + i} ssh2`,
        }),
      );
    }
    await ingest({
      source: SRC_B,
      sourceIp: IP_B,
      severity: 'CRITICAL',
      message: 'GET /promo?code=50%_OFF HTTP/1.1 200',
    });
    sealedId = await ingest({
      source: SRC_B,
      severity: 'INFO',
      message: 'user jdoe opened the reports page',
    });
  });

  describe('GET /logs', () => {
    it('returns a page object; filters by several sources; newest first', async () => {
      const res = await get(`/api/v1/logs?source=${SRC_A},${SRC_B}`).expect(
        200,
      );
      const body = res.body as LogPageBody;
      expect(body.total).toBe(7);
      expect(body.limit).toBe(100);
      expect(body.offset).toBe(0);
      expect(body.items).toHaveLength(7);
      expect(body.items[0].id).toBe(sealedId);
      expect(body.items.every((l) => l.batchStatus === null)).toBe(true);
    });

    it('paginates with limit/offset and keeps the total', async () => {
      const p1 = (
        await get(`/api/v1/logs?source=${SRC_A},${SRC_B}&limit=3&offset=0`)
      ).body as LogPageBody;
      const p3 = (
        await get(`/api/v1/logs?source=${SRC_A},${SRC_B}&limit=3&offset=6`)
      ).body as LogPageBody;
      const past = (
        await get(`/api/v1/logs?source=${SRC_A},${SRC_B}&limit=3&offset=30`)
      ).body as LogPageBody;
      expect(p1.items).toHaveLength(3);
      expect(p3.items).toHaveLength(1);
      expect(p1.total).toBe(7);
      expect(p3.total).toBe(7);
      expect(past).toMatchObject({ items: [], total: 7, offset: 30 });
      expect(new Set([...p1.items, ...p3.items].map((l) => l.id)).size).toBe(4);
    });

    it('filters by severity and eventType (AND with source)', async () => {
      const body = (
        await get(
          `/api/v1/logs?source=${SRC_A},${SRC_B}&severity=CRITICAL,INFO&eventType=SYSLOG`,
        )
      ).body as LogPageBody;
      expect(body.total).toBe(2);
      expect(body.items.map((l) => l.severity).sort()).toEqual([
        'CRITICAL',
        'INFO',
      ]);
    });

    it('q is a case-insensitive literal substring of message', async () => {
      const ci = (
        await get(`/api/v1/logs?source=${SRC_A},${SRC_B}&q=FAILED%20PASSWORD`)
      ).body as LogPageBody;
      expect(ci.total).toBe(5);
      // "%" ใน q ต้องเป็นตัวอักษร ไม่ใช่ wildcard
      const pct = (
        await get(
          `/api/v1/logs?source=${SRC_A},${SRC_B}&q=${encodeURIComponent('50%_off')}`,
        )
      ).body as LogPageBody;
      expect(pct.total).toBe(1);
      const wildcard = (
        await get(
          `/api/v1/logs?source=${SRC_A},${SRC_B}&q=${encodeURIComponent('%')}`,
        )
      ).body as LogPageBody;
      expect(wildcard.total).toBe(1);
    });

    it('rejects bad paging / unknown params with 400', async () => {
      await get('/api/v1/logs?limit=1001').expect(400);
      await get('/api/v1/logs?limit=0').expect(400);
      await get('/api/v1/logs?offset=-1').expect(400);
      await get('/api/v1/logs?page=2').expect(400);
    });

    it('after sealing: batchStatus, txHash, blockNumber, polygonscanUrl', async () => {
      await seal();
      const body = (await get(`/api/v1/logs?source=${SRC_A},${SRC_B}`))
        .body as LogPageBody;
      for (const l of body.items) {
        expect(l.batchStatus).toBe('CONFIRMED');
        expect(l.batchId).toEqual(expect.any(String));
        expect(l.txHash).toMatch(/^0x[0-9a-f]{64}$/);
        expect(typeof l.blockNumber).toBe('number');
        expect(l.polygonscanUrl).toBe(explorerTxUrl(l.txHash));
      }
    });
  });

  describe('GET /logs/:id', () => {
    it('200 for a log, 404 for an unknown UUID, 400 for a non-UUID', async () => {
      const ok = await get(`/api/v1/logs/${sealedId}`).expect(200);
      expect((ok.body as { id: string }).id).toBe(sealedId);
      await get(`/api/v1/logs/${randomUUID()}`).expect(404);
      await get('/api/v1/logs/abc12345').expect(400);
    });
  });

  describe('alerts: source IP + alert_logs', () => {
    let alertA: string;
    let alertB: string;
    let alert5715: string;

    it('5710 from two IPs on the same source are two rows', async () => {
      const base = {
        alertType: 'RULE_MATCH',
        severity: 'CRITICAL',
        source: SRC_A,
        title: 'Multiple authentication failures (brute force)',
        detail: { rule_id: 5710 },
      };
      const a = await alerts.createOrDedup(
        { ...base, logId: failIds[4], sourceIp: IP_A },
        { relatedLogIds: failIds },
      );
      const b = await alerts.createOrDedup(
        { ...base, logId: failIds[3], sourceIp: IP_B },
        { relatedLogIds: [failIds[3]] },
      );
      alertA = a.id;
      alertB = b.id;
      expect(alertA).not.toBe(alertB);

      const rows: Array<{ source_ip: string }> = await ds.query(
        `SELECT host(source_ip) AS source_ip FROM alerts
          WHERE source = $1 AND rule_id = '5710' AND status = 'OPEN' ORDER BY source_ip`,
        [SRC_A],
      );
      expect(rows.map((r) => r.source_ip)).toEqual([IP_B, IP_A]);
    });

    it('a repeat from the same IP increments the count and links the log as repeat', async () => {
      repeatId = await ingest({
        source: SRC_A,
        sourceIp: IP_A,
        severity: 'WARNING',
        message: 'Failed password for root from 203.0.113.5 port 52399 ssh2',
      });
      const again = await alerts.createOrDedup(
        {
          alertType: 'RULE_MATCH',
          severity: 'CRITICAL',
          source: SRC_A,
          sourceIp: IP_A,
          logId: repeatId,
          title: 'Multiple authentication failures (brute force)',
          detail: { rule_id: 5710 },
        },
        { relatedLogIds: [...failIds.slice(1), repeatId] },
      );
      expect(again.id).toBe(alertA);
      expect(again.occurrenceCount).toBe(2);
    });

    it('5715 links its trigger and the 5710 logs as prior', async () => {
      const ok = await ingest({
        source: SRC_A,
        sourceIp: IP_A,
        message: 'Accepted publickey for kan from 203.0.113.5 port 52400 ssh2',
      });
      const a = await alerts.createOrDedup(
        {
          alertType: 'RULE_MATCH',
          severity: 'WARNING',
          source: SRC_A,
          sourceIp: IP_A,
          logId: ok,
          title: 'Successful login after multiple failures',
          detail: { rule_id: 5715 },
        },
        { relatedLogIds: [ok], priorLogIds: failIds },
      );
      alert5715 = a.id;
      const rows: Array<{ role: string; n: string }> = await ds.query(
        `SELECT role, COUNT(*) AS n FROM alert_logs WHERE alert_id = $1 GROUP BY role ORDER BY role`,
        [alert5715],
      );
      expect(rows).toEqual([
        { role: 'prior', n: '5' },
        { role: 'trigger', n: '1' },
      ]);
    });

    it('GET /alerts/:id returns the alert (sourceIp, occurrenceCount) and every role', async () => {
      const res = await get(`/api/v1/alerts/${alertA}`).expect(200);
      const body = res.body as {
        alert: { id: string; sourceIp: string; occurrenceCount: number };
        logs: Array<{
          id: string;
          role: string;
          sourceIp: string | null;
          batchStatus: string | null;
          message: string;
        }>;
      };
      expect(body.alert).toMatchObject({
        id: alertA,
        sourceIp: IP_A,
        occurrenceCount: 2,
      });
      const byRole = (r: string) =>
        body.logs.filter((l) => l.role === r).map((l) => l.id);
      expect(byRole('trigger')).toEqual([failIds[4]]);
      expect(byRole('window').sort()).toEqual(failIds.slice(0, 4).sort());
      expect(byRole('repeat')).toEqual([repeatId]);
      // trigger มาก่อน · log ที่ seal แล้ว/ยังไม่ seal
      expect(body.logs[0].role).toBe('trigger');
      expect(body.logs.find((l) => l.id === failIds[0])?.batchStatus).toBe(
        'CONFIRMED',
      );
      expect(body.logs.find((l) => l.id === repeatId)?.batchStatus).toBeNull();
      expect(body.logs[0].sourceIp).toBe(IP_A);

      const p = (await get(`/api/v1/alerts/${alert5715}`)).body as {
        logs: Array<{ role: string }>;
      };
      expect(p.logs.map((l) => l.role)).toEqual([
        'trigger',
        'prior',
        'prior',
        'prior',
        'prior',
        'prior',
      ]);
    });

    it('GET /alerts/:id: 404 unknown, 400 non-UUID', async () => {
      await get(`/api/v1/alerts/${randomUUID()}`).expect(404);
      await get('/api/v1/alerts/not-a-uuid').expect(400);
    });

    it('GET /alerts still returns an array and carries sourceIp', async () => {
      const res = await get('/api/v1/alerts').expect(200);
      const mine = (res.body as Array<{ id: string; sourceIp: string }>).find(
        (a) => a.id === alertB,
      );
      expect(Array.isArray(res.body)).toBe(true);
      expect(mine?.sourceIp).toBe(IP_B);
    });

    it('deleting an alert cascades its alert_logs', async () => {
      const n = async () =>
        Number(
          (
            await ds.query(
              'SELECT COUNT(*) AS c FROM alert_logs WHERE alert_id = $1',
              [alertB],
            )
          )[0].c,
        );
      expect(await n()).toBe(1);
      await ds.query('DELETE FROM alerts WHERE id = $1', [alertB]);
      expect(await n()).toBe(0);
    });
  });

  describe('GET /logs/:id/detail', () => {
    interface DetailBody {
      log: { id: string; rawHash: string; retentionDays: number };
      batch: {
        id: string;
        status: string;
        merkleRoot: string;
        polygonscanUrl: string | null;
        blockNumber: number;
      } | null;
      proof: { verified: boolean; path: unknown[] } | null;
      alerts: Array<{ id: string; role: string; ruleId: string }>;
      chainCheck:
        | { chainRoot: string; dbRoot: string; match: boolean }
        | { error: string }
        | null;
    }

    it('sealed: batch, verified proof, linked alerts and a matching chain root', async () => {
      const res = await get(`/api/v1/logs/${failIds[0]}/detail`).expect(200);
      const d = res.body as DetailBody;
      expect(d.log.id).toBe(failIds[0]);
      expect(d.log.retentionDays).toBe(365);
      expect(d.batch?.status).toBe('CONFIRMED');
      expect(typeof d.batch?.blockNumber).toBe('number');
      expect(d.proof?.verified).toBe(true);
      expect(d.chainCheck).toMatchObject({
        dbRoot: '0x' + d.batch!.merkleRoot,
        chainRoot: '0x' + d.batch!.merkleRoot,
        match: true,
      });
      // failIds[0] อยู่ใน window ของ 5710 (IP A) และเป็น prior ของ 5715
      expect(d.alerts.map((a) => [a.ruleId, a.role]).sort()).toEqual([
        ['5710', 'window'],
        ['5715', 'prior'],
      ]);
    });

    it('not sealed: batch / proof / chainCheck are null', async () => {
      const d = (await get(`/api/v1/logs/${repeatId}/detail`).expect(200))
        .body as DetailBody;
      expect(d.batch).toBeNull();
      expect(d.proof).toBeNull();
      expect(d.chainCheck).toBeNull();
      expect(d.alerts.map((a) => a.role)).toEqual(['repeat']);
    });

    it('RPC down: still 200, chainCheck has an error', async () => {
      rpcDown = true;
      try {
        const d = (await get(`/api/v1/logs/${sealedId}/detail`).expect(200))
          .body as DetailBody;
        expect(d.batch?.status).toBe('CONFIRMED');
        expect(d.chainCheck).toMatchObject({
          error: expect.stringContaining('ECONNREFUSED'),
        });
      } finally {
        rpcDown = false;
      }
    });

    it('a root missing on chain → match false', async () => {
      const d0 = (await get(`/api/v1/logs/${sealedId}/detail`))
        .body as DetailBody;
      const key = d0.batch!.id.toLowerCase();
      const saved = chainMap.get(key)!;
      chainMap.delete(key);
      try {
        const d = (await get(`/api/v1/logs/${sealedId}/detail`))
          .body as DetailBody;
        expect(d.chainCheck).toMatchObject({
          chainRoot: ZERO_ROOT,
          match: false,
        });
      } finally {
        chainMap.set(key, saved);
      }
    });

    it('404 / 400 like GET /logs/:id', async () => {
      await get(`/api/v1/logs/${randomUUID()}/detail`).expect(404);
      await get('/api/v1/logs/xyz/detail').expect(400);
    });

    it('is written to audit_access', async () => {
      await get(`/api/v1/logs/${sealedId}/detail`, 'auditor').expect(200);
      // AuditMiddleware เขียนตอน response finish แบบ fire-and-forget
      let rows: Array<{ status_code: number }> = [];
      for (let i = 0; i < 20 && !rows.length; i++) {
        await new Promise((r) => setTimeout(r, 100));
        rows = await ds.query(
          `SELECT status_code FROM audit_access
            WHERE user_id = 'e2e-log-onchain' AND resource = $1`,
          [`/api/v1/logs/${sealedId}/detail`],
        );
      }
      expect(rows.map((r) => r.status_code)).toContain(200);
    });
  });

  describe('roles', () => {
    const cases: Array<[string, string, number]> = [
      ['GET /logs', 'auditor', 403],
      ['GET /logs', 'ingestor', 403],
      ['GET /logs/:id/detail', 'auditor', 200],
      ['GET /logs/:id/detail', 'operator', 200],
      ['GET /logs/:id/detail', 'ingestor', 403],
      ['GET /alerts/:id', 'auditor', 403],
      ['GET /alerts/:id', 'operator', 200],
    ];
    it.each(cases)('%s as %s → %d', async (ep, role, code) => {
      const alertId: string = (
        await ds.query(
          `SELECT id FROM alerts WHERE source = $1 ORDER BY created_at LIMIT 1`,
          [SRC_A],
        )
      )[0].id;
      const path = {
        'GET /logs': '/api/v1/logs',
        'GET /logs/:id/detail': `/api/v1/logs/${sealedId}/detail`,
        'GET /alerts/:id': `/api/v1/alerts/${alertId}`,
      }[ep]!;
      await get(path, role).expect(code);
    });

    it('no token → 401', async () => {
      await request(http()).get(`/api/v1/logs/${sealedId}/detail`).expect(401);
    });
  });
});
