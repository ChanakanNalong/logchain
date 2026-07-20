import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Alerts Integration', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /alerts should return array', async () => {
    const res = await request(app.getHttpServer())
      .get('/alerts')
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /alerts should create alert', async () => {
    const res = await request(app.getHttpServer())
      .post('/alerts')
      .send({
        alertType: 'INTRUSION',
        severity: 'HIGH',
        source: 'suricata',
        title: 'Test alert',
        detail: { test: true },
      })
      .expect(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.status).toBe('OPEN');
  });

  it('POST /alerts same type should dedup', async () => {
    await request(app.getHttpServer())
      .post('/alerts')
      .send({
        alertType: 'INTRUSION',
        severity: 'HIGH',
        source: 'suricata',
        title: 'Test alert',
      });

    const res = await request(app.getHttpServer())
      .post('/alerts')
      .send({
        alertType: 'INTRUSION',
        severity: 'HIGH',
        source: 'suricata',
        title: 'Test alert',
      })
      .expect(201);

    const all = await request(app.getHttpServer()).get('/alerts');
    const dupes = all.body.filter(
      (a: any) => a.alertType === 'INTRUSION' && a.source === 'suricata',
    );
    expect(dupes.length).toBe(1);
  });

  it('PATCH /alerts/:id/resolve should resolve alert', async () => {
    const create = await request(app.getHttpServer())
      .post('/alerts')
      .send({
        alertType: 'PORTSCAN',
        severity: 'MEDIUM',
        source: 'wazuh',
        title: 'Port scan detected',
      });

    const id = create.body.id;
    const res = await request(app.getHttpServer())
      .patch('/alerts/' + id + '/resolve')
      .expect(200);
    expect(res.body.status).toBe('RESOLVED');
  });
});
