/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
// ชุดทดลอง: อ่าน body ของ supertest และผล ds.query ซึ่งเป็น any โดยธรรมชาติ — ปิด unsafe-any เฉพาะไฟล์นี้
/**
 * Tamper scenarios on environment hh — REAL Hardhat chain (127.0.0.1:8545) + hh Postgres.
 *
 * ต่างจาก tamper-diff.integration.spec.ts: ไม่ override BlockchainService → anchor จริงบน Hardhat
 * (batch เป็น CONFIRMED จริง) เพื่อดูว่า proof / chain root / snapshot diff / alert เปลี่ยนยังไงเมื่อ:
 *   A แก้ message อย่างเดียว (ไม่แตะ raw_hash)
 *   B แก้ message + คำนวณ raw_hash ใหม่ให้ตรง (จำลองผู้โจมตีที่รู้สูตร)
 *   C แก้ sourceIp (ไม่แตะ raw_hash)
 *   D ลบ log ทั้งแถว (logs + log_batch_mapping)
 *   E เพิ่ม log ปลอมแล้ว map เข้า batch
 *
 * auth: ใช้ test-roles guard แทน Keycloak เฉพาะชุดทดสอบนี้ (Keycloak ปิด direct grant + admin ต้อง OTP
 * จึงขอ token อัตโนมัติไม่ได้) — โค้ด controller/service จริงทุกตัว · ทุก DISABLE TRIGGER ENABLE คืนใน finally
 * ผลเขียนเป็น JSON ที่ TAMPER_RESULTS_FILE (หรือ scratchpad) เพื่อนำไปทำรายงาน
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
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { AppModule } from '../src/app.module';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';
import { computeRawHash } from '../src/logs/services/log-hash';

// ⚠️ ต้องมี Hardhat node จริง (127.0.0.1:8545) + contract ที่ deploy แล้ว + hh Postgres/Vault
// CI ปกติ (ci.yml → jest-e2e รันทุก *.integration.spec.ts) ไม่มี Hardhat และตั้งใจไม่ตั้ง CONTRACT_ADDRESS
// → ถ้าถูกหยิบไปรันที่นั่นจะแดง จึง skip เว้นแต่ตั้ง TAMPER_HH=1 (ตั้งเฉพาะตอนรันบน hh ด้วยมือ)
const runHh = process.env.TAMPER_HH === '1';
const describeHh = runHh ? describe : describe.skip;

const RUN = randomBytes(3).toString('hex');
const SOURCE = `tamper-exp-${RUN}`;
const ALL_ROLES = 'admin,auditor,analyst,operator,ingestor';
const OUT =
  process.env.TAMPER_RESULTS_FILE ?? join(tmpdir(), 'tamper-results.json');

interface LogRow {
  id: string;
  source: string;
  source_ip: string | null;
  event_type: string;
  severity: string;
  message: string;
  raw_hash: string;
  classification: string;
  cde_scope: boolean;
  retention_days: number;
  created_at: string;
  position?: number;
}

describeHh('Tamper scenarios (hh, real chain)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let batchId: string;
  let rows: LogRow[]; // 8 logs ของ batch เรียงตาม snapshot position 0..7
  const results: Record<string, unknown> = {
    run: RUN,
    source: SOURCE,
    scenarios: [],
  };

  const http = () => app.getHttpServer() as App;
  const get = (p: string) =>
    request(http()).get(p).set({ 'x-test-roles': ALL_ROLES });
  const post = (p: string, body?: unknown) =>
    request(http())
      .post(p)
      .set({ 'x-test-roles': ALL_ROLES })
      .send(body ?? {});

  /** ปิด trigger ชั่วคราวแล้ว ENABLE คืนเสมอใน finally (แม้ query ล้ม) */
  const noUpdate = async (fn: () => Promise<void>) => {
    await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update');
    try {
      await fn();
    } finally {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update');
    }
  };
  const noDelete = async (fn: () => Promise<void>) => {
    await ds.query('ALTER TABLE logs DISABLE TRIGGER trg_logs_no_delete');
    try {
      await fn();
    } finally {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
    }
  };

  const verifyNow = async () => {
    const r = await post('/api/v1/logs/verify-now');
    return r.status;
  };

  const batchStatus = async (): Promise<string> => {
    const r: Array<{ status: string }> = await ds.query(
      'SELECT status FROM batches WHERE id = $1',
      [batchId],
    );
    return r[0]?.status ?? '(gone)';
  };
  const alertsOf = async () =>
    ds.query(
      `SELECT alert_type, title, severity, rule_id, status
         FROM alerts WHERE batch_id = $1 ORDER BY created_at DESC`,
      [batchId],
    );

  const proof = async (logId: string) => {
    const r = await get(`/api/v1/logs/${logId}/proof`);
    if (r.status !== 200) return { status: r.status };
    return {
      status: 200,
      verify: r.body.verify,
      integrity: r.body.integrity,
      rawHash: r.body.rawHash,
      contentHash: r.body.contentHash,
      batchStatus: r.body.batch?.status,
    };
  };
  const diffNow = async () => {
    const r = await get(`/api/v1/batches/${batchId}/diff`);
    const b = r.body;
    return {
      httpStatus: r.status,
      verdict: b.summary?.verdict,
      dbRoot: b.dbRoot,
      chainRoot: b.chainRoot,
      snapshotRoot: b.snapshotRoot,
      storedHashRoot: b.storedHashRoot,
      contentRoot: b.contentRoot,
      snapshotTrusted: b.snapshotTrusted,
      trustBasis: b.trustBasis,
      untrustedReasons: b.untrustedReasons,
      changes: (b.changes ?? []).map((c: Record<string, unknown>) => ({
        position: c.position,
        type: c.type,
        reason: c.reason,
        fields: (c.fields as Array<Record<string, unknown>> | undefined)?.map(
          (f) => ({
            field: f.field,
            before: f.before,
            after: f.after,
          }),
        ),
      })),
    };
  };
  const treeNow = async () => {
    const r = await get(`/api/v1/batches/${batchId}/tree`);
    const b = r.body;
    return {
      httpStatus: r.status,
      dbRoot: b.dbRoot,
      snapshotRoot: b.snapshotRoot,
      storedHashRoot: b.storedHashRoot,
      storedHashRootMatchesDb: b.storedHashRootMatchesDb,
      contentRoot: b.contentRoot,
      contentRootMatchesDb: b.contentRootMatchesDb,
      chainRoot: b.chainRoot,
    };
  };
  const detailChainCheck = async (logId: string) => {
    const r = await get(`/api/v1/logs/${logId}/detail`);
    return r.status === 200
      ? {
          status: 200,
          proofVerified: r.body.proof?.verified,
          chainCheck: r.body.chainCheck,
        }
      : { status: r.status };
  };

  /** บันทึกสถานะเต็มหลัง verify-now: subject = log ที่ถูกแตะ (หรือ fake/null), untouched = log#1 (pos0) */
  const capture = async (subjectId: string | null) => ({
    verifyHttp: undefined as number | undefined,
    batchStatus: await batchStatus(),
    tree: await treeNow(),
    diff: await diffNow(),
    proofSubject: subjectId ? await proof(subjectId) : null,
    proofUntouched: await proof(rows[0].id),
    detailSubjectChainCheck: subjectId
      ? await detailChainCheck(subjectId)
      : null,
    alerts: await alertsOf(),
  });

  const runScenario = async (
    name: string,
    desc: string,
    subjectId: string | null,
    apply: () => Promise<void>,
    restore: () => Promise<void>,
  ) => {
    await apply();
    const verifyHttp = await verifyNow();
    const observed = await capture(subjectId);
    observed.verifyHttp = verifyHttp;
    await restore();
    const afterVerify = await verifyNow();
    const afterStatus = await batchStatus();
    const afterDiff = await diffNow();
    (results.scenarios as unknown[]).push({
      name,
      desc,
      observed,
      restored: {
        verifyHttp: afterVerify,
        batchStatus: afterStatus,
        diffVerdict: afterDiff.verdict,
      },
    });
    return observed;
  };

  beforeAll(async () => {
    process.env.SEAL_BATCH_SIZE = '500';
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
          userId: 'tamper-exp',
          username: 'tamper-exp',
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

    // หยุด cron ทั้งหมด (seal/verify อัตโนมัติ) — ควบคุมจังหวะเอง
    const registry = app.get(SchedulerRegistry);
    for (const [cronName, job] of registry.getCronJobs()) {
      (job as { stop: () => void }).stop();
      registry.deleteCronJob(cronName);
    }
  }, 120_000);

  afterAll(async () => {
    // safety net: trigger ต้อง enable เสมอ
    try {
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_update');
      await ds.query('ALTER TABLE logs ENABLE TRIGGER trg_logs_no_delete');
    } catch {
      /* ignore */
    }
    if (app) await app.close();
  });

  it('prepare + run A–E + restore', async () => {
    // 1) seal log ค้างของคนอื่นไปก่อน ให้ batch ของเราสะอาด
    for (const url of ['/api/v1/logs/seal-now']) {
      for (let i = 0; i < 60; i++) {
        const r = await post(url);
        if (r.status !== 200 || r.body?.message === 'No pending logs to seal')
          break;
      }
    }

    // 2) ingest 8 logs (message/sourceIp ต่างกัน)
    for (let i = 0; i < 8; i++) {
      await request(http())
        .post('/api/v1/logs')
        .set({ 'x-test-roles': 'ingestor' })
        .send({
          source: SOURCE,
          sourceIp: `203.0.113.${10 + i}`,
          eventType: 'SYSLOG',
          severity: i % 2 ? 'WARNING' : 'INFO',
          message: `event #${i} from host-${i} action=login user=u${i}`,
        })
        .expect(201);
    }

    // 3) seal → batch เดียว แล้ว verify-now ให้ anchor + CONFIRMED
    await post('/api/v1/logs/seal-now').expect(200);
    await verifyNow();

    const mrows: Array<{ batch_id: string; n: string }> = await ds.query(
      `SELECT m.batch_id, COUNT(*) n FROM log_batch_mapping m
         JOIN logs l ON l.id = m.log_id WHERE l.source = $1 GROUP BY m.batch_id`,
      [SOURCE],
    );
    expect(mrows).toHaveLength(1);
    expect(Number(mrows[0].n)).toBe(8);
    batchId = mrows[0].batch_id;

    rows = await ds.query(
      `SELECT l.id, l.source, l.source_id::text AS source_ip, l.event_type, l.severity,
              l.message, l.raw_hash, l.classification, l.cde_scope, l.retention_days,
              l.created_at, s.position
         FROM batch_log_snapshot s JOIN logs l ON l.id = s.log_id
        WHERE s.batch_id = $1 ORDER BY s.position`,
      [batchId],
    );
    expect(rows).toHaveLength(8);

    // 3b) backup logs + mapping ของ batch นี้ลงไฟล์ (ใช้ restore)
    const mapping: Array<{
      log_id: string;
      batch_id: string;
      mapped_at: string;
    }> = await ds.query(
      'SELECT log_id, batch_id, mapped_at FROM log_batch_mapping WHERE batch_id = $1',
      [batchId],
    );
    writeFileSync(
      OUT.replace(/\.json$/, '') + '.backup.json',
      JSON.stringify({ batchId, rows, mapping }, null, 2),
    );

    // baseline (CONFIRMED + INTACT)
    results.batchId = batchId;
    results.baseline = {
      batchStatus: await batchStatus(),
      tree: await treeNow(),
      diff: await diffNow(),
      proofLog1: await proof(rows[0].id),
      proofLog3: await proof(rows[2].id),
      detailLog1ChainCheck: await detailChainCheck(rows[0].id),
      alerts: await alertsOf(),
    };
    expect(results.baseline).toBeDefined();

    const r3 = rows[2]; // log ตัวที่ 3 (position 2)
    const r4 = rows[3]; // ตัวที่ 4
    const r5 = rows[4]; // ตัวที่ 5

    // A — แก้ message อย่างเดียว ไม่แตะ raw_hash
    const obsA = await runScenario(
      'A',
      'แก้ message ของ log ตัวที่ 3 (ไม่แตะ raw_hash)',
      r3.id,
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET message = $2 WHERE id = $1', [
            r3.id,
            'TAMPERED message A — injected',
          ]);
        }),
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET message = $2 WHERE id = $1', [
            r3.id,
            r3.message,
          ]);
        }),
    );
    // แก้ message: contentRoot ต้องแดง (≠ chain) · proof ต้อง false · storedHashRoot ยังเขียว (raw_hash เดิม)
    expect(obsA.diff.contentRoot).not.toBe(obsA.diff.chainRoot);
    expect(obsA.diff.storedHashRoot).toBe(obsA.diff.chainRoot);
    expect(obsA.proofSubject?.verify).toBe(false);
    expect(obsA.proofSubject?.integrity).toBe('CONTENT_MODIFIED');

    // B — แก้ message + คำนวณ raw_hash ใหม่ให้ตรงเนื้อหาใหม่
    const forgedMsg = 'FORGED B — attacker recomputed raw_hash';
    const forgedHash = computeRawHash({
      id: r3.id,
      source: r3.source,
      sourceIp: r3.source_ip,
      eventType: r3.event_type,
      severity: r3.severity,
      message: forgedMsg,
      classification: r3.classification,
      cdeScope: r3.cde_scope,
      createdAt: new Date(r3.created_at),
    });
    await runScenario(
      'B',
      'แก้ message ของ log ตัวที่ 3 + raw_hash ใหม่ให้ตรง (จำลองผู้โจมตีรู้สูตร)',
      r3.id,
      () =>
        noUpdate(async () => {
          await ds.query(
            'UPDATE logs SET message = $2, raw_hash = $3 WHERE id = $1',
            [r3.id, forgedMsg, forgedHash],
          );
        }),
      () =>
        noUpdate(async () => {
          await ds.query(
            'UPDATE logs SET message = $2, raw_hash = $3 WHERE id = $1',
            [r3.id, r3.message, r3.raw_hash],
          );
        }),
    );

    // C — แก้ sourceIp ของ log ตัวที่ 5 (ไม่แตะ raw_hash)
    const obsC = await runScenario(
      'C',
      'แก้ sourceIp ของ log ตัวที่ 5 (ไม่แตะ raw_hash)',
      r5.id,
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET source_id = $2::inet WHERE id = $1', [
            r5.id,
            '8.8.8.8',
          ]);
        }),
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET source_id = $2::inet WHERE id = $1', [
            r5.id,
            r5.source_ip,
          ]);
        }),
    );
    // แก้ sourceIp (เนื้อหา) → เหมือน A: contentRoot แดง · proof false · storedHashRoot ยังเขียว
    expect(obsC.diff.contentRoot).not.toBe(obsC.diff.chainRoot);
    expect(obsC.diff.storedHashRoot).toBe(obsC.diff.chainRoot);
    expect(obsC.proofSubject?.verify).toBe(false);
    expect(obsC.proofSubject?.integrity).toBe('CONTENT_MODIFIED');

    // D — ลบ log ตัวที่ 4 (logs + log_batch_mapping)
    await runScenario(
      'D',
      'ลบ log ตัวที่ 4 ทั้งแถว (logs + log_batch_mapping)',
      r4.id,
      () =>
        noDelete(async () => {
          await ds.query('DELETE FROM log_batch_mapping WHERE log_id = $1', [
            r4.id,
          ]);
          await ds.query('DELETE FROM logs WHERE id = $1', [r4.id]);
        }),
      () =>
        noDelete(async () => {
          await ds.query(
            `INSERT INTO logs (id, source, source_id, event_type, severity, message, raw_hash,
                             classification, cde_scope, retention_days, created_at)
           VALUES ($1,$2,$3::inet,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              r4.id,
              r4.source,
              r4.source_ip,
              r4.event_type,
              r4.severity,
              r4.message,
              r4.raw_hash,
              r4.classification,
              r4.cde_scope,
              r4.retention_days,
              r4.created_at,
            ],
          );
          await ds.query(
            'INSERT INTO log_batch_mapping (log_id, batch_id, mapped_at) VALUES ($1,$2, now())',
            [r4.id, batchId],
          );
        }),
    );

    // E — เพิ่ม log ปลอม 1 ตัวแล้ว map เข้า batch นี้
    const fakeId = (await ds.query('SELECT gen_random_uuid() AS id'))[0]
      .id as string;
    const fakeHash = computeRawHash({
      id: fakeId,
      source: SOURCE,
      sourceIp: '66.66.66.66',
      eventType: 'SYSLOG',
      severity: 'CRITICAL',
      message: 'FAKE E — injected after seal',
      classification: 'INTERNAL',
      cdeScope: false,
      createdAt: new Date(),
    });
    await runScenario(
      'E',
      'เพิ่ม log ปลอม 1 ตัว แล้ว map เข้า batch',
      fakeId,
      () =>
        noUpdate(async () => {
          // insert ไม่ถูก trigger บล็อก แต่กันไว้ใน finally อยู่ดี
          await ds.query(
            `INSERT INTO logs (id, source, source_id, event_type, severity, message, raw_hash,
                             classification, cde_scope, retention_days, created_at)
           VALUES ($1,$2,$3::inet,$4,$5,$6,$7,$8,$9,$10, now())`,
            [
              fakeId,
              SOURCE,
              '66.66.66.66',
              'SYSLOG',
              'CRITICAL',
              'FAKE E — injected after seal',
              fakeHash,
              'INTERNAL',
              false,
              365,
            ],
          );
          await ds.query(
            'INSERT INTO log_batch_mapping (log_id, batch_id, mapped_at) VALUES ($1,$2, now())',
            [fakeId, batchId],
          );
        }),
      () =>
        noDelete(async () => {
          await ds.query('DELETE FROM log_batch_mapping WHERE log_id = $1', [
            fakeId,
          ]);
          await ds.query('DELETE FROM logs WHERE id = $1', [fakeId]);
        }),
    );

    // F — แก้แค่คอลัมน์ raw_hash ของ log ตัวที่ 5 (เนื้อหาเดิม) = demo-tamper
    //      storedHashRoot ต้องแดง · contentRoot ยังเขียว (เนื้อหาไม่เปลี่ยน) · proof.integrity = HASH_MODIFIED
    const obsF = await runScenario(
      'F',
      'แก้คอลัมน์ raw_hash ของ log ตัวที่ 5 เป็น all-f (เนื้อหาเดิม)',
      r5.id,
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET raw_hash = $2 WHERE id = $1', [
            r5.id,
            'f'.repeat(64),
          ]);
        }),
      () =>
        noUpdate(async () => {
          await ds.query('UPDATE logs SET raw_hash = $2 WHERE id = $1', [
            r5.id,
            r5.raw_hash,
          ]);
        }),
    );
    expect(obsF.diff.storedHashRoot).not.toBe(obsF.diff.chainRoot);
    expect(obsF.diff.contentRoot).toBe(obsF.diff.chainRoot);
    expect(obsF.proofSubject?.integrity).toBe('HASH_MODIFIED');

    // final: ยืนยันสะอาด (ไม่แก้อะไร → ทุก root เขียว · proof ผ่าน)
    await verifyNow();
    const finalStatus = await batchStatus();
    const finalDiff = await diffNow();
    const trg: Array<{ tgname: string; tgenabled: string }> = await ds.query(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgname IN ('trg_logs_no_update','trg_logs_no_delete')`,
    );
    results.final = {
      batchStatus: finalStatus,
      diffVerdict: finalDiff.verdict,
      tree: await treeNow(),
      triggers: trg,
      proofLog1: await proof(rows[0].id),
      proofLog3: await proof(rows[2].id),
    };

    writeFileSync(OUT, JSON.stringify(results, null, 2));
    // sanity: จบแล้วต้อง CONFIRMED + INTACT + trigger enabled
    expect(finalStatus).toBe('CONFIRMED');
    expect(finalDiff.verdict).toBe('INTACT');
    expect(trg.every((t) => t.tgenabled === 'O')).toBe(true);
    // ไม่แก้อะไร (baseline/หลัง restore ครบ): ทุก root เขียว · proof ผ่าน · integrity INTACT
    expect(finalDiff.storedHashRoot).toBe(finalDiff.chainRoot);
    expect(finalDiff.contentRoot).toBe(finalDiff.chainRoot);
    const finalProof = await proof(rows[2].id);
    expect(finalProof.verify).toBe(true);
    expect(finalProof.integrity).toBe('INTACT');
  }, 300_000);
});
