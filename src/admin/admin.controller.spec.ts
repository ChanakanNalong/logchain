import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { AdminController } from './admin.controller';
import { KeycloakAdminService, KeycloakUser } from './keycloak-admin.service';
import { AuditService } from '../audit/audit.service';
import { APP_ROLES } from './admin.constants';

/**
 * Guard tests — ยิง controller ตรง ๆ ด้วย KeycloakAdminService ที่ mock ไว้
 * ไม่มี network ออกไปหา Keycloak จริงในเทสชุดนี้
 */

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '33333333-3333-4333-8333-333333333333';

function user(id: string, username: string, enabled = true): KeycloakUser {
  return { id, username, enabled, email: `${username}@logchain.local` };
}

/** request ปลอมที่มี identity แบบเดียวกับที่ JwtStrategy.validate คืน */
function req(overrides: Partial<Record<string, any>> = {}) {
  return {
    method: 'DELETE',
    ip: '10.0.0.9',
    headers: {},
    user: { userId: CALLER_ID, username: 'admin-user', roles: ['admin'] },
    ...overrides,
  };
}

describe('AdminController', () => {
  let controller: AdminController;
  let keycloak: jest.Mocked<KeycloakAdminService>;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    keycloak = {
      listUsers: jest.fn(),
      getUserRoles: jest.fn(),
      getRoleUsers: jest.fn().mockResolvedValue([]),
      assignRealmRole: jest.fn().mockResolvedValue(undefined),
      removeRealmRole: jest.fn().mockResolvedValue(undefined),
      setUserEnabled: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KeycloakAdminService>;

    audit = { log: jest.fn().mockResolvedValue(undefined) };

    const module = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        { provide: KeycloakAdminService, useValue: keycloak },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    controller = module.get(AdminController);
  });

  /** ให้ /roles/:name/users ตอบตาม role ที่ถูกถาม */
  function withRoleMembers(members: Record<string, KeycloakUser[]>) {
    keycloak.getRoleUsers.mockImplementation(
      async (role: string) => members[role] ?? [],
    );
  }

  // ── GET /admin/roles — allowlist ────────────────────────────────────────

  describe('GET /admin/roles', () => {
    it('returns the fixed 5-role allowlist', () => {
      expect(controller.listRoles()).toEqual([
        'admin',
        'operator',
        'ingestor',
        'analyst',
        'auditor',
      ]);
    });

    it('returns a copy so a caller cannot mutate the allowlist', () => {
      controller.listRoles().push('manage-realm');
      expect(controller.listRoles()).not.toContain('manage-realm');
      expect(APP_ROLES).toHaveLength(5);
    });
  });

  // ── GET /admin/users — role filter ──────────────────────────────────────

  describe('GET /admin/users', () => {
    it('joins users with their app roles', async () => {
      keycloak.listUsers.mockResolvedValue([
        user(CALLER_ID, 'admin-user'),
        user(TARGET_ID, 'analyst-user'),
      ]);
      withRoleMembers({
        admin: [user(CALLER_ID, 'admin-user')],
        auditor: [user(CALLER_ID, 'admin-user')],
        analyst: [user(TARGET_ID, 'analyst-user')],
      });

      const result = await controller.listUsers();

      expect(result).toEqual([
        expect.objectContaining({ id: CALLER_ID, username: 'admin-user' }),
        expect.objectContaining({ id: TARGET_ID, username: 'analyst-user' }),
      ]);
      expect(result[0].roles.sort()).toEqual(['admin', 'auditor']);
      expect(result[1].roles).toEqual(['analyst']);
    });

    it('never leaks Keycloak built-in roles — membership is queried per app role only', async () => {
      keycloak.listUsers.mockResolvedValue([user(TARGET_ID, 'plain-user')]);
      // ทุก user ใน Keycloak มี default-roles-*/offline_access/uma_authorization ติดมาเสมอ
      // ที่นี่ไม่เคยถาม role พวกนั้น จึงหลุดออก response ไม่ได้
      withRoleMembers({});

      const result = await controller.listUsers();

      expect(result[0].roles).toEqual([]);
      const queried = keycloak.getRoleUsers.mock.calls.map(([role]) => role);
      expect(queried.sort()).toEqual([...APP_ROLES].sort());
      expect(queried).not.toContain('default-roles-logchain');
    });

    it('reports a user with no app role as an empty role list, not undefined', async () => {
      keycloak.listUsers.mockResolvedValue([user(TARGET_ID, 'orphan')]);

      const result = await controller.listUsers();

      expect(result[0].roles).toEqual([]);
    });
  });

  // ── POST /admin/users/:id/roles — allowlist ─────────────────────────────

  describe('POST /admin/users/:id/roles', () => {
    it('assigns an allowlisted role and audits it as ROLE_ASSIGN', async () => {
      const request = req({ method: 'POST' });

      await controller.assignRole(TARGET_ID, { role: 'auditor' }, request);

      expect(keycloak.assignRealmRole).toHaveBeenCalledWith(
        TARGET_ID,
        'auditor',
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: CALLER_ID,
          username: 'admin-user',
          action: 'ROLE_ASSIGN',
          resource: `user:${TARGET_ID} role:auditor`,
          method: 'POST',
          statusCode: 200,
          ipAddress: '10.0.0.9',
        }),
      );
    });

    it('takes the actor from the JWT, never from the request body', async () => {
      const request = req({
        method: 'POST',
        body: { userId: 'attacker-supplied' },
      });

      await controller.assignRole(TARGET_ID, { role: 'analyst' }, request);

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ userId: CALLER_ID }),
      );
    });
  });

  // ── DELETE /admin/users/:id/roles/:role ─────────────────────────────────

  describe('DELETE /admin/users/:id/roles/:role', () => {
    it('rejects a role outside the allowlist with 400', async () => {
      await expect(
        controller.removeRole(TARGET_ID, 'manage-realm', req()),
      ).rejects.toThrow(BadRequestException);

      expect(keycloak.removeRealmRole).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects a Keycloak built-in role with 400', async () => {
      await expect(
        controller.removeRole(TARGET_ID, 'default-roles-logchain', req()),
      ).rejects.toThrow(BadRequestException);
    });

    it('blocks the caller from removing their own admin role with 403', async () => {
      withRoleMembers({
        admin: [
          user(CALLER_ID, 'admin-user'),
          user(OTHER_ADMIN_ID, 'second-admin'),
        ],
      });

      await expect(
        controller.removeRole(CALLER_ID, 'admin', req()),
      ).rejects.toThrow(ForbiddenException);

      expect(keycloak.removeRealmRole).not.toHaveBeenCalled();
    });

    it('lets the caller drop a non-admin role from their own account', async () => {
      await controller.removeRole(CALLER_ID, 'analyst', req());

      expect(keycloak.removeRealmRole).toHaveBeenCalledWith(
        CALLER_ID,
        'analyst',
      );
    });

    it('returns 409 when removing admin from the last active admin', async () => {
      withRoleMembers({ admin: [user(TARGET_ID, 'only-admin')] });

      await expect(
        controller.removeRole(TARGET_ID, 'admin', req()),
      ).rejects.toThrow(ConflictException);

      expect(keycloak.removeRealmRole).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('allows removing admin while another active admin remains', async () => {
      withRoleMembers({
        admin: [user(TARGET_ID, 'admin-a'), user(OTHER_ADMIN_ID, 'admin-b')],
      });

      await controller.removeRole(TARGET_ID, 'admin', req());

      expect(keycloak.removeRealmRole).toHaveBeenCalledWith(TARGET_ID, 'admin');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ROLE_REVOKE',
          resource: `user:${TARGET_ID} role:admin`,
        }),
      );
    });

    it('does not count disabled admins as the remaining admin — 409 still fires', async () => {
      withRoleMembers({
        admin: [
          user(TARGET_ID, 'active-admin'),
          user(OTHER_ADMIN_ID, 'locked-admin', false),
        ],
      });

      await expect(
        controller.removeRole(TARGET_ID, 'admin', req()),
      ).rejects.toThrow(ConflictException);
    });

    it('allows removing admin from a disabled user even when one active admin is left', async () => {
      const disabledTarget = user(TARGET_ID, 'locked-admin', false);
      withRoleMembers({
        admin: [user(OTHER_ADMIN_ID, 'active-admin'), disabledTarget],
      });

      await controller.removeRole(TARGET_ID, 'admin', req());

      expect(keycloak.removeRealmRole).toHaveBeenCalledWith(TARGET_ID, 'admin');
    });

    it('skips the last-admin count entirely when removing a non-admin role', async () => {
      withRoleMembers({ admin: [user(TARGET_ID, 'only-admin')] });

      await controller.removeRole(TARGET_ID, 'auditor', req());

      expect(keycloak.getRoleUsers).not.toHaveBeenCalled();
      expect(keycloak.removeRealmRole).toHaveBeenCalledWith(
        TARGET_ID,
        'auditor',
      );
    });
  });

  // ── PATCH /admin/users/:id ──────────────────────────────────────────────

  describe('PATCH /admin/users/:id', () => {
    it('blocks disabling your own account with 403', async () => {
      await expect(
        controller.updateUser(
          CALLER_ID,
          { enabled: false },
          req({ method: 'PATCH' }),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(keycloak.setUserEnabled).not.toHaveBeenCalled();
    });

    it('blocks any self-targeted status change with 403', async () => {
      await expect(
        controller.updateUser(
          CALLER_ID,
          { enabled: true },
          req({ method: 'PATCH' }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns 409 when disabling the last active admin', async () => {
      withRoleMembers({ admin: [user(TARGET_ID, 'only-admin')] });

      await expect(
        controller.updateUser(
          TARGET_ID,
          { enabled: false },
          req({ method: 'PATCH' }),
        ),
      ).rejects.toThrow(ConflictException);

      expect(keycloak.setUserEnabled).not.toHaveBeenCalled();
    });

    it('disables a non-admin user and audits USER_DISABLE', async () => {
      await controller.updateUser(
        TARGET_ID,
        { enabled: false },
        req({ method: 'PATCH' }),
      );

      expect(keycloak.setUserEnabled).toHaveBeenCalledWith(TARGET_ID, false);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: CALLER_ID,
          action: 'USER_DISABLE',
          resource: `user:${TARGET_ID}`,
          method: 'PATCH',
        }),
      );
    });

    it('re-enabling a user skips the last-admin check and audits USER_ENABLE', async () => {
      await controller.updateUser(
        TARGET_ID,
        { enabled: true },
        req({ method: 'PATCH' }),
      );

      expect(keycloak.getRoleUsers).not.toHaveBeenCalled();
      expect(keycloak.setUserEnabled).toHaveBeenCalledWith(TARGET_ID, true);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'USER_ENABLE' }),
      );
    });

    it('disables an admin while another active admin remains', async () => {
      withRoleMembers({
        admin: [user(TARGET_ID, 'admin-a'), user(OTHER_ADMIN_ID, 'admin-b')],
      });

      await controller.updateUser(
        TARGET_ID,
        { enabled: false },
        req({ method: 'PATCH' }),
      );

      expect(keycloak.setUserEnabled).toHaveBeenCalledWith(TARGET_ID, false);
    });
  });

  // ── audit source of identity ────────────────────────────────────────────

  it('falls back to x-forwarded-for when req.ip is absent', async () => {
    const request = req({
      method: 'POST',
      ip: undefined,
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });

    await controller.assignRole(TARGET_ID, { role: 'operator' }, request);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '203.0.113.7' }),
    );
  });

  it('refuses to act when the request carries no authenticated identity', async () => {
    await expect(
      controller.removeRole(TARGET_ID, 'analyst', req({ user: undefined })),
    ).rejects.toThrow(ForbiddenException);
  });
});
