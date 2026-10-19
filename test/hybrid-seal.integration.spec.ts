/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
// อ่าน body ของ supertest และผล ds.query ซึ่งเป็น any โดยธรรมชาติ — ปิด unsafe-any เฉพาะไฟล์นี้
/**
 * Hybrid seal บน environment hh — REAL Hardhat chain (127.0.0.1:8545) + hh Postgres.
 *
 * ตรวจพฤติกรรม SEAL_MODE=hybrid กับ SEAL_MAX_WAIT_MINUTES=2, SEAL_BATCH_SIZE=100:
 *   1) ingest 250 → tick แรก (count) ปิด 2 batch × 100, เหลือ 50 ค้าง · ทุกใบ CONFIRMED (anchor จริง)
 *      tick ถัดมาทันที (อายุ < 2 นาที, เหลือ < 100) ต้อง "ไม่" seal 50 ที่เหลือ
 *      รอจนอายุ > 2 นาที → tick (age) ปิด 50 ที่เหลือใบเดียว · verify ผ่านทุกใบ
 *   2) seal-now แทรกระหว่าง count drain → คิว sealQueue ต้อง serialize: ไม่มี log_id ซ้ำใน
 *      log_batch_mapping (PK จริงของ DB จะฟ้องถ้า seal ซ้อน) และ log ถูกปิดครบไม่ขาดไม่เกิน
 *
 * คุม cron เอง (หยุดทั้ง seal/verify) แล้วเรียก runHybridSealTick()/sealBatch() ตรง เพื่อให้
 * จังหวะ deterministic · อายุใช้เวลาจริง (ห้าม back-date created_at — createdAt อยู่ใน raw_hash
 * แก้แล้ว verify จะเป็น TAMPERED) · auth ใช้ test-roles guard แทน Keycloak (เหมือน tamper spec)
 *
 * CI (jest-e2e รันทุก *.integration.spec.ts) ไม่มี Hardhat → skip เว้นแต่ HYBRID_HH=1 (รันบน hh ด้วยมือ)
 */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '@nestjs/passport';
import { SchedulerRegistry } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { IntegrityService } from '../src/integrity/integrity.service';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';

const runHh = process.env.HYBRID_HH === '1';
const describeHh = runHh ? describe : describe.skip;

const RUN = randomBytes(3).toString('hex');
const BATCH_SIZE = 100;
const MAX_WAIT_MIN = 2;
const ALL_ROLES = 'admin,auditor,analyst,operator,ingestor';

describeHh('Hybrid seal (hh, real chain)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let integrity: IntegrityService;

  const http = () => app.getHttpServer() as App;
  const post = (p: string, body?: unknown) =>
    request(http())
      .post(p)
      .set({ 'x-test-roles': ALL_ROLES })
      .send(body ?? {});

  /** ปิด log ค้างของ run ก่อน ๆ ให้หมด ก่อนเริ่ม (seal-now ทีละใบ) */
  const drainAll = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await post('/api/v1/logs/seal-now');
      if (r.status !== 200 || r.body?.message === 'No pending logs to seal')
        break;
    }
  };

  const ingest = async (source: string, n: number) => {
    // ยิงทีละตัว (supertest ผูก ephemeral port ต่อ request — ยิงขนานบน server เดียวชนกัน → ECONNRESET)
    for (let i = 0; i < n; i++) {
      await request(http())
        .post('/api/v1/logs')
        .set({ 'x-test-roles': 'ingestor' })
        .send({
          source,
          sourceIp: `203.0.113.${(i % 250) + 1}`,
          eventType: 'SYSLOG',
          severity: i % 2 ? 'WARNING' : 'INFO',
          message: `hybrid ${RUN} #${i}`,
        })
        .expect(201);
    }
  };

  /** batch ที่มี log ของ source นี้: id, log_count, status, seal_reason */
  const batchesOf = async (
    source: string,
  ): Promise<
    Array<{ id: string; n: number; status: string; seal_reason: string | null }>
  > => {
    const rows = await ds.query(
      `SELECT b.id, b.status, b.seal_reason, COUNT(*)::int AS n
         FROM batches b
         JOIN log_batch_mapping m ON m.batch_id = b.id
         JOIN logs l ON l.id = m.log_id
        WHERE l.source = $1
        GROUP BY b.id, b.status, b.seal_reason
        ORDER BY MIN(l.created_at)`,
      [source],
    );
    return rows.map((r: any) => ({
      id: r.id,
      n: Number(r.n),
      status: r.status,
      seal_reason: r.seal_reason,
    }));
  };

  const pendingOf = async (source: string): Promise<number> => {
    const r = await ds.query(
      `SELECT COUNT(*)::int AS n FROM logs l
         LEFT JOIN log_batch_mapping m ON m.log_id = l.id
        WHERE l.source = $1 AND m.log_id IS NULL`,
      [source],
    );
    return Number(r[0].n);
  };

  beforeAll(async () => {
    process.env.SEAL_MODE = 'hybrid';
    process.env.SEAL_MAX_WAIT_MINUTES = String(MAX_WAIT_MIN);
    process.env.SEAL_BATCH_SIZE = String(BATCH_SIZE);
    process.env.SEAL_MIN_BALANCE_TX = '0';

    class HeaderRolesGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        const req = ctx.switchToHttp().getRequest<{
          headers: Record<string, string | undefined>;
          user?: unknown;
        }>();
        const h = req.headers['x-test-roles'];
        if (h === undefined) throw new UnauthorizedException();
        req.user = {
          userId: 'hybrid-exp',
          username: 'hybrid-exp',
          roles: h.split(',').filter(Boolean),
        };
        return true;
      }
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useClass(HeaderRolesGuard)
      .overrideProvider(KafkaProducerService)
      .useValue({ publishLog: () => Promise.resolve() })
      .overrideProvider(KafkaConsumerService)
      .useValue({ getHealth: () => ({ connected: true }) })
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

    // หยุด cron ทั้งหมด — คุมจังหวะ tick เอง (ไม่งั้น hybrid/verify cron แทรกจังหวะทดสอบ)
    const registry = app.get(SchedulerRegistry);
    for (const [cronName, job] of registry.getCronJobs()) {
      (job as { stop: () => void }).stop();
      registry.deleteCronJob(cronName);
    }
    expect(integrity.sealConfig.mode).toBe('hybrid');
    expect(integrity.sealConfig.maxWaitMinutes).toBe(MAX_WAIT_MIN);
    expect(integrity.sealConfig.batchSize).toBe(BATCH_SIZE);
  }, 180_000);

  afterAll(async () => {
    try {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update');
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
    } catch {
      /* ignore */
    }
    if (app) await app.close();
  });

  it('count → 2×100 CONFIRMED, เหลือ 50 ค้าง · ไม่ seal ก่อนครบ 2 นาที · age → ปิด 50', async () => {
    const SOURCE = `hybrid-count-age-${RUN}`;
    await drainAll();
    const t0 = Date.now();
    await ingest(SOURCE, 250);

    // tick 1 — count: pending 250 ≥ 100 → ปิดเฉพาะ batch เต็ม (floor(250/100)=2), เหลือ 50
    const tick1 = await integrity.runHybridSealTick();
    expect(tick1.batches.map((b) => b.logCount)).toEqual([100, 100]);
    expect(tick1.batches.every((b) => b.status === 'CONFIRMED')).toBe(true);

    let batches = await batchesOf(SOURCE);
    expect(batches.map((b) => b.n)).toEqual([100, 100]);
    expect(batches.every((b) => b.status === 'CONFIRMED')).toBe(true);
    expect(batches.every((b) => b.seal_reason === 'count')).toBe(true);
    expect(await pendingOf(SOURCE)).toBe(50);

    // tick 2 ทันที — อายุ < 2 นาที และ 50 < 100 → ต้องไม่ seal อะไรเลย
    const tick2 = await integrity.runHybridSealTick();
    expect(tick2.batches).toHaveLength(0);
    expect(await pendingOf(SOURCE)).toBe(50);

    // รอจนอายุของ log เก่าสุด > MAX_WAIT (เวลาจริง — ห้าม back-date เพราะ createdAt อยู่ใน raw_hash)
    const waitMs = MAX_WAIT_MIN * 60_000 + 5_000 - (Date.now() - t0);
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    // tick 3 — age: log เก่าสุดค้าง ≥ 2 นาที → ปิดทั้งหมดที่เหลือ (50 ใบเดียว รวม batch ไม่เต็ม)
    const tick3 = await integrity.runHybridSealTick();
    expect(tick3.batches.map((b) => b.logCount)).toEqual([50]);
    expect(tick3.batches[0].status).toBe('CONFIRMED');
    expect(await pendingOf(SOURCE)).toBe(0);

    batches = await batchesOf(SOURCE);
    expect(batches.map((b) => b.n)).toEqual([100, 100, 50]);
    expect(batches.map((b) => b.seal_reason)).toEqual([
      'count',
      'count',
      'age',
    ]);
    expect(batches.every((b) => b.status === 'CONFIRMED')).toBe(true);

    // log ของ source นี้ถูก map ครบ 250 ตัว ไม่ซ้ำ
    const mapped = await ds.query(
      `SELECT COUNT(*)::int all_n, COUNT(DISTINCT m.log_id)::int distinct_n
         FROM log_batch_mapping m JOIN logs l ON l.id = m.log_id WHERE l.source = $1`,
      [SOURCE],
    );
    expect(Number(mapped[0].all_n)).toBe(250);
    expect(Number(mapped[0].distinct_n)).toBe(250);

    // verify ทุก batch ผ่าน (recompute root จาก log ปัจจุบัน + เทียบ chain) — ไม่มี TAMPERED
    await integrity.verifyAllBatches();
    const after = await batchesOf(SOURCE);
    expect(after.every((b) => b.status === 'CONFIRMED')).toBe(true);
  }, 200_000);

  it('seal-now แทรกระหว่าง count drain → ไม่ seal ซ้อน, ไม่มี log_id ซ้ำ', async () => {
    const SOURCE = `hybrid-concurrent-${RUN}`;
    await drainAll();
    await ingest(SOURCE, 250);

    // ยิง hybrid tick (count drain) พร้อม seal-now 2 ครั้งพร้อมกัน — คิว sealQueue ต้อง serialize
    // ถ้า seal ซ้อน ทั้งคู่จะเห็น pending ชุดเดียวกันแล้ว INSERT log_batch_mapping ชน PK (log_id) จริง
    const results = await Promise.allSettled([
      integrity.runHybridSealTick(),
      integrity.sealBatch('manual'),
      integrity.sealBatch('manual'),
    ]);
    // ไม่มีตัวไหน reject เพราะ PK ชน (= ไม่มีการ seal ซ้อน)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const mapped = await ds.query(
      `SELECT COUNT(*)::int all_n, COUNT(DISTINCT m.log_id)::int distinct_n
         FROM log_batch_mapping m JOIN logs l ON l.id = m.log_id WHERE l.source = $1`,
      [SOURCE],
    );
    // 250 log ถูก map ครบ ไม่ซ้ำ
    expect(Number(mapped[0].all_n)).toBe(250);
    expect(Number(mapped[0].distinct_n)).toBe(250);

    const batches = await batchesOf(SOURCE);
    expect(batches.every((b) => b.n <= BATCH_SIZE)).toBe(true);
    expect(batches.reduce((s, b) => s + b.n, 0)).toBe(250);
  }, 120_000);
});
