import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { AdminController } from '../admin/admin.controller';
import { KeycloakAdminService } from '../admin/keycloak-admin.service';
import { AlertsController } from '../alerts/alerts.controller';
import { AlertsService } from '../alerts/alerts.service';
import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import { AuditService } from '../audit/audit.service';
import { ComplianceController } from '../compliance/compliance.controller';
import { ComplianceService } from '../compliance/compliance.service';
import { ErasureController } from '../erasure/erasure.controller';
import { ErasureService } from '../erasure/erasure.service';
import { HealthController } from '../health/health.controller';
import { BatchesController } from '../integrity/batches.controller';
import { IntegrityController } from '../integrity/integrity.controller';
import { IntegrityService } from '../integrity/integrity.service';
import { KafkaConsumerService } from '../kafka/kafka-consumer.service';
import { LogsController } from '../logs/logs.controller';
import { LogService } from '../logs/logs.service';
import { StatsController } from '../stats/stats.controller';
import { StatsService } from '../stats/stats.service';

/**
 * สิทธิ์ของ 5 role ต่อทุก endpoint ที่ต้อง login — ยิง HTTP จริงผ่าน RolesGuard ตัวจริง
 *
 * AuthGuard('jwt') ถูกแทนด้วย guard ปลอมที่อ่าน role จาก header `x-test-roles`
 * (มีเฉพาะในไฟล์ test นี้ — โค้ดจริงไม่มีทางรับ role จาก header)
 * service ทุกตัวเป็น mock: เทสนี้ดูแค่ว่า guard ปล่อย/บล็อกถูก role ไม่ได้ดู business logic
 *
 * แก้ @Roles ที่ไหน ต้องแก้ตาราง ALLOWED ตรงนี้ให้ตรงสเปคด้วย
 */

const ROLES = ['admin', 'analyst', 'operator', 'auditor', 'ingestor'] as const;
type Role = (typeof ROLES)[number];

const UUID = '11111111-1111-4111-8111-111111111111';

interface Endpoint {
  method: 'get' | 'post' | 'patch' | 'delete';
  path: string;
  body?: object;
  ok: number;
  allowed: readonly Role[];
}

const READERS: readonly Role[] = ['admin', 'analyst', 'operator'];

const ENDPOINTS: Endpoint[] = [
  // logs
  {
    method: 'post',
    path: '/api/v1/logs',
    body: {},
    ok: 201,
    allowed: ['admin', 'ingestor'],
  },
  { method: 'get', path: '/api/v1/logs', ok: 200, allowed: READERS },
  { method: 'get', path: `/api/v1/logs/${UUID}`, ok: 200, allowed: READERS },
  // alerts
  {
    method: 'post',
    path: '/api/v1/alerts',
    body: {},
    ok: 201,
    allowed: ['admin'],
  },
  { method: 'get', path: '/api/v1/alerts', ok: 200, allowed: READERS },
  {
    method: 'patch',
    path: `/api/v1/alerts/${UUID}/resolve`,
    ok: 200,
    allowed: ['admin', 'operator'],
  },
  // integrity
  {
    method: 'post',
    path: '/api/v1/logs/verify-now',
    ok: 200,
    allowed: ['admin'],
  },
  {
    method: 'post',
    path: '/api/v1/logs/seal-now',
    ok: 200,
    allowed: ['admin'],
  },
  {
    method: 'get',
    path: `/api/v1/logs/${UUID}/proof`,
    ok: 200,
    allowed: READERS,
  },
  {
    method: 'get',
    path: '/api/v1/batches',
    ok: 200,
    allowed: [...READERS, 'auditor'],
  },
  // stats
  { method: 'get', path: '/api/v1/stats/overview', ok: 200, allowed: READERS },
  { method: 'get', path: '/api/v1/stats/traffic', ok: 200, allowed: READERS },
  // compliance
  {
    method: 'get',
    path: '/api/v1/compliance/reports',
    ok: 200,
    allowed: ['admin', 'auditor'],
  },
  // erasure
  {
    method: 'delete',
    path: '/api/v1/erasure/user/someone',
    ok: 200,
    allowed: ['admin'],
  },
  // admin — role/target เลือกให้เลี่ยง self guard กับ last-admin guard (เทสแยกอยู่ใน admin.controller.spec.ts)
  { method: 'get', path: '/api/v1/admin/users', ok: 200, allowed: ['admin'] },
  { method: 'get', path: '/api/v1/admin/roles', ok: 200, allowed: ['admin'] },
  {
    method: 'post',
    path: `/api/v1/admin/users/${UUID}/roles`,
    body: { role: 'analyst' },
    ok: 200,
    allowed: ['admin'],
  },
  {
    method: 'delete',
    path: `/api/v1/admin/users/${UUID}/roles/analyst`,
    ok: 200,
    allowed: ['admin'],
  },
  {
    method: 'patch',
    path: `/api/v1/admin/users/${UUID}`,
    body: { enabled: true },
    ok: 200,
    allowed: ['admin'],
  },
];

/** แทน AuthGuard('jwt'): ไม่มี header = ไม่มี token (401) · header ว่าง = token ที่ไม่มี role */
class HeaderRolesAuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      user?: unknown;
    }>();
    const header = req.headers['x-test-roles'];
    if (header === undefined) throw new UnauthorizedException();
    req.user = {
      userId: 'rbac-test-caller',
      username: 'rbac-test',
      roles: String(header).split(',').filter(Boolean),
    };
    return true;
  }
}

const mocks = {
  logs: {
    ingest: jest.fn().mockResolvedValue({ id: UUID }),
    findRecent: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue({ id: UUID }),
  },
  alerts: {
    createOrDedup: jest.fn().mockResolvedValue({ id: UUID }),
    findAll: jest.fn().mockResolvedValue([]),
    resolve: jest.fn().mockResolvedValue({ id: UUID, status: 'RESOLVED' }),
  },
  integrity: {
    reanchorUnverified: jest.fn().mockResolvedValue(undefined),
    verifyAllBatches: jest.fn().mockResolvedValue(undefined),
    sealBatch: jest.fn().mockResolvedValue(null),
    getProofForLog: jest.fn().mockResolvedValue({
      log: { id: UUID, rawHash: 'h' },
      batch: {
        id: UUID,
        merkleRoot: 'r',
        txHash: null,
        blockNumber: null,
        status: 'SEALED',
      },
      proof: [],
      verified: true,
    }),
    listBatches: jest.fn().mockResolvedValue([]),
  },
  stats: {
    getOverview: jest.fn().mockResolvedValue({}),
    getTraffic: jest.fn().mockResolvedValue({}),
  },
  compliance: { getReports: jest.fn().mockResolvedValue({}) },
  erasure: {
    eraseUser: jest.fn().mockResolvedValue({ tombstone: { pseudonym: 'p' } }),
  },
  keycloak: {
    listUsers: jest.fn().mockResolvedValue([]),
    getRoleUsers: jest.fn().mockResolvedValue([]),
    assignRealmRole: jest.fn().mockResolvedValue(undefined),
    removeRealmRole: jest.fn().mockResolvedValue(undefined),
    setUserEnabled: jest.fn().mockResolvedValue(undefined),
  },
  audit: { log: jest.fn().mockResolvedValue(undefined) },
  kafkaConsumer: { getHealth: jest.fn().mockReturnValue({ connected: true }) },
};

describe('RBAC matrix (role × endpoint)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AppController,
        HealthController,
        LogsController,
        AlertsController,
        IntegrityController,
        BatchesController,
        StatsController,
        ComplianceController,
        ErasureController,
        AdminController,
      ],
      providers: [
        AppService,
        { provide: LogService, useValue: mocks.logs },
        { provide: AlertsService, useValue: mocks.alerts },
        { provide: IntegrityService, useValue: mocks.integrity },
        { provide: StatsService, useValue: mocks.stats },
        { provide: ComplianceService, useValue: mocks.compliance },
        { provide: ErasureService, useValue: mocks.erasure },
        { provide: KeycloakAdminService, useValue: mocks.keycloak },
        { provide: AuditService, useValue: mocks.audit },
        { provide: KafkaConsumerService, useValue: mocks.kafkaConsumer },
      ],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useClass(HeaderRolesAuthGuard)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (e: Endpoint, roles?: string) => {
    let req = request(app.getHttpServer() as Server)[e.method](e.path);
    if (roles !== undefined) req = req.set('x-test-roles', roles);
    return e.body ? req.send(e.body) : req;
  };

  const cases = ENDPOINTS.flatMap((e) =>
    ROLES.map((role) => ({
      name: `${e.method.toUpperCase()} ${e.path}`,
      role,
      e,
      expected: e.allowed.includes(role) ? e.ok : 403,
    })),
  );

  it.each(cases)('$role → $name = $expected', async ({ role, e, expected }) => {
    const res = await call(e, role);
    expect(res.status).toBe(expected);
  });

  it.each(
    ENDPOINTS.map((e) => [`${e.method.toUpperCase()} ${e.path}`, e] as const),
  )('token ที่ไม่มี app role เลย → 403: %s', async (_name, e) => {
    expect((await call(e, '')).status).toBe(403);
  });

  it.each(
    ENDPOINTS.map((e) => [`${e.method.toUpperCase()} ${e.path}`, e] as const),
  )('ไม่มี token → 401: %s', async (_name, e) => {
    expect((await call(e)).status).toBe(401);
  });

  // ตั้งใจเปิด: health check ของ docker/demo-preflight และ root ไม่มี guard
  it.each(['/health', '/api/v1'])(
    'GET %s เรียกได้โดยไม่มี token (ตั้งใจให้เปิด)',
    async (path) => {
      const res = await request(app.getHttpServer() as Server).get(path);
      expect(res.status).toBe(200);
    },
  );
});
