import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { KeycloakAdminService } from './keycloak-admin.service';
import { VaultService } from '../vault/vault.service';

/**
 * Token lifecycle tests — global fetch ถูก mock ทั้งหมด ไม่มี request จริงออกไป
 */

const KC = 'http://localhost:8080';
const TOKEN_URL = `${KC}/realms/logchain/protocol/openid-connect/token`;
const ADMIN_BASE = `${KC}/admin/realms/logchain`;

function jsonRes(body: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyRes(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => null,
    text: async () => '',
  } as unknown as Response;
}

const tokenRes = (token: string, expiresIn = 60) =>
  jsonRes({ access_token: token, expires_in: expiresIn });

describe('KeycloakAdminService', () => {
  let service: KeycloakAdminService;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const module = await Test.createTestingModule({
      providers: [
        KeycloakAdminService,
        {
          provide: VaultService,
          useValue: {
            init: jest.fn().mockResolvedValue(undefined),
            get: jest.fn(() => ({
              keycloak: { adminClientSecret: 'svc-secret' },
            })),
          },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((_key: string, fallback: any) => fallback) },
        },
      ],
    }).compile();

    service = module.get(KeycloakAdminService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** คำขอ token ทุกครั้งใน mock ตามด้วย response ของ admin call ที่ระบุ */
  function tokenCalls() {
    return fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
  }

  // ── token ──────────────────────────────────────────────────────────────

  it('requests the admin token with a client_credentials grant and the Vault secret', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1'))
      .mockResolvedValueOnce(jsonRes([]));

    await service.listUsers();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('client_id')).toBe('logchain-admin-svc');
    expect(body.get('client_secret')).toBe('svc-secret');
  });

  it('caches the token across calls instead of re-authenticating each time', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1', 300))
      .mockResolvedValue(jsonRes([]));

    await service.listUsers();
    await service.listUsers();
    await service.getUserRoles('u1');

    expect(tokenCalls()).toHaveLength(1);
  });

  it('re-authenticates once the cached token has expired', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-09T00:00:00Z'));
    fetchMock.mockImplementation(async (url: string) =>
      url === TOKEN_URL ? tokenRes('t', 60) : jsonRes([]),
    );

    await service.listUsers();
    expect(tokenCalls()).toHaveLength(1);

    // 60s ttl ลบ skew 30s -> ยังไม่หมดที่ 20 วิ
    jest.setSystemTime(new Date('2026-08-09T00:00:20Z'));
    await service.listUsers();
    expect(tokenCalls()).toHaveLength(1);

    // ผ่านหน้ากัน skew แล้ว ต้องขอใหม่
    jest.setSystemTime(new Date('2026-08-09T00:00:45Z'));
    await service.listUsers();
    expect(tokenCalls()).toHaveLength(2);
  });

  it('shares one token request between calls that race on a cold cache', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === TOKEN_URL ? tokenRes('t1', 300) : jsonRes([]),
    );

    await Promise.all([
      service.listUsers(),
      service.listUsers(),
      service.getUserRoles('u1'),
    ]);

    expect(tokenCalls()).toHaveLength(1);
  });

  it('fails loudly when Vault has no admin client secret', async () => {
    const vault = {
      init: jest.fn(),
      get: () => ({ keycloak: { adminClientSecret: '' } }),
    };
    const module = await Test.createTestingModule({
      providers: [
        KeycloakAdminService,
        { provide: VaultService, useValue: vault },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d: any) => d },
        },
      ],
    }).compile();

    await expect(module.get(KeycloakAdminService).listUsers()).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed token request as 503 without leaking the response body', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes({ error: 'invalid_client' }, 401));

    await expect(service.listUsers()).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  // ── admin REST ─────────────────────────────────────────────────────────

  it('sends the bearer token on admin calls', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1'))
      .mockResolvedValueOnce(jsonRes([]));

    await service.listUsers();

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toContain(`${ADMIN_BASE}/users`);
    expect(init.headers.Authorization).toBe('Bearer t1');
  });

  it('pages through /users until a short page comes back', async () => {
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `u${i}`,
        username: `u${i}`,
        enabled: true,
      }));

    fetchMock
      .mockResolvedValueOnce(tokenRes('t1', 300))
      .mockResolvedValueOnce(jsonRes(page(100)))
      .mockResolvedValueOnce(jsonRes(page(7)));

    const users = await service.listUsers();

    expect(users).toHaveLength(107);
    expect(fetchMock.mock.calls[1][0]).toContain('first=0&max=100');
    expect(fetchMock.mock.calls[2][0]).toContain('first=100&max=100');
  });

  it('maps a 404 from Keycloak to NotFoundException', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1'))
      .mockResolvedValueOnce(emptyRes(404));

    await expect(service.getUserRoles('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('assigns a realm role using the role representation Keycloak requires', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1', 300))
      .mockResolvedValueOnce(
        jsonRes({ id: 'role-uuid', name: 'auditor', extra: 'ignored' }),
      )
      .mockResolvedValueOnce(emptyRes());

    await service.assignRealmRole('user-1', 'auditor');

    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(`${ADMIN_BASE}/users/user-1/role-mappings/realm`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual([
      { id: 'role-uuid', name: 'auditor' },
    ]);
  });

  it('caches the role representation instead of re-fetching it per mutation', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === TOKEN_URL) return tokenRes('t1', 300);
      if (url.endsWith('/roles/auditor'))
        return jsonRes({ id: 'role-uuid', name: 'auditor' });
      return emptyRes();
    });

    await service.assignRealmRole('user-1', 'auditor');
    await service.removeRealmRole('user-2', 'auditor');

    const roleLookups = fetchMock.mock.calls.filter(([url]) =>
      url.endsWith('/roles/auditor'),
    );
    expect(roleLookups).toHaveLength(1);
  });

  it('removes a realm role with DELETE on the role-mappings endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1', 300))
      .mockResolvedValueOnce(jsonRes({ id: 'role-uuid', name: 'admin' }))
      .mockResolvedValueOnce(emptyRes());

    await service.removeRealmRole('user-1', 'admin');

    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(`${ADMIN_BASE}/users/user-1/role-mappings/realm`);
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body)).toEqual([{ id: 'role-uuid', name: 'admin' }]);
  });

  it('sets enabled with a PUT on the user representation', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes('t1', 300))
      .mockResolvedValueOnce(emptyRes());

    await service.setUserEnabled('user-1', false);

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe(`${ADMIN_BASE}/users/user-1`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ enabled: false });
  });
});
