import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';
import { DataSource } from 'typeorm';

type Tombstone = {
  userId: string;
  requestedBy: string;
  recordsDeleted: number;
  method: string;
  pseudonym: string;
  hash: string;
};
type EraseResponse = { tombstone: Tombstone; referencesPseudonymized: number };
type ReportResponse = { erasure: { records: Tombstone[] }[] };

describe('Erasure Integration', () => {
  let app: INestApplication;
  let db: DataSource;
  // ขึ้นต้นเฉพาะ — afterAll ลบเฉพาะแถวของเทสต์นี้ (erasure_log เป็น append-only)
  const TEST_USER = `e2e-erasure-${Date.now()}`;
  // แถว audit ที่ถูก pseudonymize แล้วไม่ขึ้นต้น e2e-erasure- — จดไว้ลบตอนจบ
  const pseudonyms: string[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: any) => {
          // รูปแบบเดียวกับที่ JwtStrategy.validate คืน (ไม่ใช่ JWT payload ดิบ)
          ctx.switchToHttp().getRequest().user = {
            userId: 'e2e-test-user',
            username: 'e2e-dpo',
            roles: ['admin'],
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
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
    await app.init();
    db = app.get(DataSource);
  });

  afterAll(async () => {
    // tombstone ห้ามลบโดยปกติ (trigger) — ปิดชั่วคราวเฉพาะเก็บกวาดแถวของเทสต์
    await db.query(
      `ALTER TABLE erasure_log DISABLE TRIGGER trg_erasure_log_no_update`,
    );
    await db.query(
      `DELETE FROM erasure_log WHERE user_id LIKE 'e2e-erasure-%'`,
    );
    await db.query(
      `ALTER TABLE erasure_log ENABLE TRIGGER trg_erasure_log_no_update`,
    );
    await db.query(
      `DELETE FROM audit_access WHERE user_id LIKE 'e2e-erasure-%' OR user_id = ANY($1)`,
      [pseudonyms],
    );
    await app.close();
  });

  it('pseudonymizes the audit trail (kept for PCI 10.5.1) and records a tombstone in the same transaction', async () => {
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO audit_access (user_id, username, action, resource, ip_address)
         VALUES ($1, 'e2e-name', 'GET', $2, '10.1.2.3')`,
        [TEST_USER, `/api/v1/me/${TEST_USER}?x=1`],
      );
    }
    // แถวของคนอื่นที่อ้างถึง user นี้ใน URL (admin แก้ role) + แถวที่ id คล้ายกันต้องไม่ถูกแตะ
    const ADMIN = `${TEST_USER}-admin`;
    await db.query(
      `INSERT INTO audit_access (user_id, action, resource) VALUES
         ($1, 'PUT', $2), ($1, 'PUT', $3)`,
      [
        ADMIN,
        `/api/v1/admin/users/${TEST_USER}/roles`,
        `/api/v1/admin/users/${TEST_USER}0/roles`,
      ],
    );

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/erasure/user/${TEST_USER}`)
      .send({ requestedBy: 'e2e-dpo' })
      .expect(200);
    const { tombstone, referencesPseudonymized } = res.body as EraseResponse;
    const P = tombstone.pseudonym;
    pseudonyms.push(P);

    expect(tombstone).toMatchObject({
      userId: TEST_USER,
      recordsDeleted: 2,
      method: 'PSEUDONYMIZE',
      // มาจากตัวตนใน JWT ไม่ใช่ body (body ส่ง 'e2e-dpo' เหมือนกันแต่ถูกเมิน — ดูเทสต์ถัดไป)
      requestedBy: 'e2e-dpo',
    });
    expect(P).toMatch(/^anon-[a-f0-9]{64}$/);
    // 2 แถวของ user เอง (resource มี id) + แถว admin 1 แถว
    expect(referencesPseudonymized).toBe(3);

    // แถวยังอยู่ครบ แต่ระบุตัวไม่ได้
    const own = await db.query(
      `SELECT user_id, username, ip_address, resource FROM audit_access WHERE user_id = $1`,
      [P],
    );
    expect(own).toEqual([
      {
        user_id: P,
        username: null,
        ip_address: null,
        resource: `/api/v1/me/${P}?x=1`,
      },
      {
        user_id: P,
        username: null,
        ip_address: null,
        resource: `/api/v1/me/${P}?x=1`,
      },
    ]);
    const adminRows = await db.query<{ resource: string }[]>(
      `SELECT resource FROM audit_access WHERE user_id = $1`,
      [ADMIN],
    );
    expect(adminRows.map((r) => r.resource).sort()).toEqual([
      `/api/v1/admin/users/${P}/roles`,
      `/api/v1/admin/users/${TEST_USER}0/roles`, // id อื่น — ไม่แตะ
    ]);

    // AuditInterceptor บันทึกคำขอลบเองแบบ fire-and-forget — รอให้เขียนเสร็จ แล้วต้องไม่มี id ตัวจริง
    await new Promise((r) => setTimeout(r, 500));
    const [{ leaked }] = await db.query<{ leaked: number }[]>(
      `SELECT count(*)::int AS leaked FROM audit_access
        WHERE user_id = $1 OR resource LIKE '%' || $1 || '/%' OR resource LIKE '%' || $1`,
      [TEST_USER],
    );
    expect(leaked).toBe(0);
    const [{ erasureCall }] = await db.query<{ erasureCall: number }[]>(
      `SELECT count(*)::int AS "erasureCall" FROM audit_access WHERE resource = $1`,
      [`/api/v1/erasure/user/${P}`],
    );
    expect(erasureCall).toBe(1);

    const rows = await db.query(
      `SELECT records_deleted, hash, method, pseudonym FROM erasure_log WHERE user_id = $1`,
      [TEST_USER],
    );
    expect(rows).toEqual([
      {
        records_deleted: 2,
        hash: tombstone.hash,
        method: 'PSEUDONYMIZE',
        pseudonym: P,
      },
    ]);

    // หน้า Reports เห็น tombstone (เดิมอ่านไฟล์ที่ไม่เคยถูกเขียน → 0 เสมอ)
    const today = new Date(Date.now() + 7 * 3600_000)
      .toISOString()
      .slice(0, 10);
    const report = await request(app.getHttpServer())
      .get(`/api/v1/compliance/reports?from=${today}&to=${today}`)
      .expect(200);
    const users = (report.body as ReportResponse).erasure.flatMap((d) =>
      d.records.map((r) => r.userId),
    );
    expect(users).toContain(TEST_USER);
  });

  it('requestedBy in the tombstone comes from the JWT, not the request body', async () => {
    const other = `${TEST_USER}-body`;
    await db.query(
      `INSERT INTO audit_access (user_id, action, resource) VALUES ($1, 'GET', '/e2e')`,
      [other],
    );

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/erasure/user/${other}`)
      .send({ requestedBy: 'someone-else' })
      .expect(200);

    const body = res.body as EraseResponse;
    pseudonyms.push(body.tombstone.pseudonym);
    expect(body.tombstone.requestedBy).toBe('e2e-dpo');
  });

  it('tombstones are append-only', async () => {
    await expect(
      db.query(`DELETE FROM erasure_log WHERE user_id = $1`, [TEST_USER]),
    ).rejects.toThrow(/IMMUTABLE_ERASURE_LOG/);
    await expect(
      db.query(
        `UPDATE erasure_log SET records_deleted = 0 WHERE user_id = $1`,
        [TEST_USER],
      ),
    ).rejects.toThrow(/IMMUTABLE_ERASURE_LOG/);
  });

  it('DELETE /erasure/user/:userId should return 404 for unknown user', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/erasure/user/unknown-user-id')
      .send({ requestedBy: 'test' })
      .expect(404);
  });
});
