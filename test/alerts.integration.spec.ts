import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AppModule } from '../src/app.module';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { AlertsService } from '../src/alerts/alerts.service';
import { Alert } from '../src/alerts/entities/alert.entity';
import { KafkaProducerService } from '../src/kafka/kafka-producer.service';
import { KafkaConsumerService } from '../src/kafka/kafka-consumer.service';

describe('Alerts Integration', () => {
  let app: INestApplication;
  let alertsService: AlertsService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: any) => {
          ctx.switchToHttp().getRequest().user = {
            sub: 'e2e-test-user',
            preferred_username: 'e2e',
            roles: ['admin', 'analyst'],
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

    alertsService = app.get(AlertsService);
  });

  afterAll(async () => {
    const repo = app.get<Repository<Alert>>(getRepositoryToken(Alert));
    await repo.delete({ source: 'suricata' });
    await repo.delete({ source: 'wazuh' });
    await app.close();
  });

  it('GET /alerts should return array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/alerts')
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('creates an alert', async () => {
    const created = await alertsService.createOrDedup({
      alertType: 'INTRUSION',
      severity: 'HIGH',
      source: 'suricata',
      title: 'Test alert',
      detail: { test: true },
    });
    expect(created).toHaveProperty('id');
    expect(created.status).toBe('OPEN');
  });

  it('dedups same type+source while OPEN', async () => {
    const first = await alertsService.createOrDedup({
      alertType: 'INTRUSION',
      severity: 'HIGH',
      source: 'suricata',
      title: 'Test alert',
    });
    const second = await alertsService.createOrDedup({
      alertType: 'INTRUSION',
      severity: 'HIGH',
      source: 'suricata',
      title: 'Test alert',
    });
    expect(second.id).toBe(first.id);
  });

  it('PATCH /alerts/:id/resolve should resolve alert', async () => {
    const created = await alertsService.createOrDedup({
      alertType: 'PORTSCAN',
      severity: 'MEDIUM',
      source: 'wazuh',
      title: 'Port scan detected',
    });

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/alerts/${created.id}/resolve`)
      .expect(200);

    expect(res.body.status).toBe('RESOLVED');
  });
});
