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
  hash: string;
};
type EraseResponse = { tombstone: Tombstone };
type ReportResponse = { erasure: { records: Tombstone[] }[] };

describe('Erasure Integration', () => {
  let app: INestApplication;
  let db: DataSource;
  // ขึ้นต้นเฉพาะ — afterAll ลบเฉพาะแถวของเทสต์นี้ (erasure_log เป็น append-only)
  const TEST_USER = `e2e-erasure-${Date.now()}`;

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
      `DELETE FROM audit_access WHERE user_id LIKE 'e2e-erasure-%'`,
    );
    await app.close();
  });

  it('erases the user and records a durable tombstone in the same transaction', async () => {
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO audit_access (user_id, action, resource) VALUES ($1, 'GET', '/e2e')`,
        [TEST_USER],
      );
    }

    const res = await request(app.getHttpServer())
      .delete(`/api/v1/erasure/user/${TEST_USER}`)
      .send({ requestedBy: 'e2e-dpo' })
      .expect(200);
    const { tombstone } = res.body as EraseResponse;

    expect(tombstone).toMatchObject({
      userId: TEST_USER,
      recordsDeleted: 2,
      // มาจากตัวตนใน JWT ไม่ใช่ body (body ส่ง 'e2e-dpo' เหมือนกันแต่ถูกเมิน — ดูเทสต์ถัดไป)
      requestedBy: 'e2e-dpo',
    });
    const [{ n }] = await db.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM audit_access WHERE user_id = $1`,
      [TEST_USER],
    );
    expect(n).toBe(0);
    const rows = await db.query<{ records_deleted: number; hash: string }[]>(
      `SELECT records_deleted, hash FROM erasure_log WHERE user_id = $1`,
      [TEST_USER],
    );
    expect(rows).toEqual([{ records_deleted: 2, hash: tombstone.hash }]);

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

    expect((res.body as EraseResponse).tombstone.requestedBy).toBe('e2e-dpo');
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
