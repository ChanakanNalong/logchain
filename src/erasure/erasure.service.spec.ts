import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import {
  ErasureService,
  pseudonymize,
  resourcePattern,
} from './erasure.service';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from './entities/erasure-log.entity';
import { VaultService } from '../vault/vault.service';

const KEY = 'ab'.repeat(32);

function makeVault(pseudonymKey: string | null = KEY) {
  return { get: () => ({ erasure: { pseudonymKey } }) } as VaultService;
}

/**
 * DataSource ปลอม: transaction() รัน callback กับ manager ปลอม · callback โยน = rollback
 * (เก็บ "สิ่งที่ commit แล้ว" แยก ให้เทสต์ดูได้ว่า rollback ทิ้งการแก้จริง)
 */
function makeDataSource(opts: {
  affected: number;
  references?: number;
  insertFails?: boolean;
}) {
  const committed = { updated: 0, tombstones: [] as Record<string, unknown>[] };
  const dataSource = {
    transaction: async (cb: (m: EntityManager) => Promise<unknown>) => {
      const pending = {
        updated: 0,
        tombstones: [] as Record<string, unknown>[],
      };
      const manager = {
        update: jest.fn(() => {
          pending.updated = opts.affected;
          return Promise.resolve({ affected: opts.affected });
        }),
        query: jest.fn(() => Promise.resolve([[], opts.references ?? 0])),
        insert: jest.fn((_entity: unknown, row: unknown) => {
          if (opts.insertFails)
            return Promise.reject(new Error('insert failed'));
          pending.tombstones.push(row as Record<string, unknown>);
          return Promise.resolve({});
        }),
      } as unknown as EntityManager;
      const result = await cb(manager); // โยน = ไม่ commit
      committed.updated += pending.updated;
      committed.tombstones.push(...pending.tombstones);
      return result;
    },
  } as unknown as DataSource;
  return { dataSource, committed };
}

describe('pseudonymize', () => {
  it('is deterministic per key and differs across keys (HMAC, not a bare hash)', () => {
    const a = pseudonymize(KEY, 'user-1');
    expect(a).toMatch(/^anon-[a-f0-9]{64}$/);
    expect(pseudonymize(KEY, 'user-1')).toBe(a);
    expect(pseudonymize('cd'.repeat(32), 'user-1')).not.toBe(a);
    expect(a.length).toBeLessThanOrEqual(128); // audit_access.user_id VARCHAR(128)
  });
});

describe('resourcePattern', () => {
  // ARE ของ Postgres กับ RegExp ของ JS ตรงกันในส่วนที่ใช้ (group · lookahead · class) — เทสต์ด้วย JS ได้
  const matches = (userId: string, resource: string) =>
    new RegExp(resourcePattern(userId)).test(resource);

  it('matches the userId only as a whole path segment or query value', () => {
    expect(matches('u-1', '/api/v1/admin/users/u-1/roles')).toBe(true);
    expect(matches('u-1', '/api/v1/admin/users/u-1')).toBe(true);
    expect(matches('u-1', '/api/v1/audit?user=u-1&x=1')).toBe(true);
    expect(matches('u-1', '/api/v1/admin/users/u-12/roles')).toBe(false);
    expect(matches('u-1', '/api/v1/admin/users/xu-1')).toBe(false);
  });

  it('escapes regex metacharacters in the userId', () => {
    expect(matches('a.b', '/users/a.b')).toBe(true);
    expect(matches('a.b', '/users/axb')).toBe(false);
  });

  it('also matches the percent-encoded form used in req.url', () => {
    expect(matches('a b', '/users/a%20b/roles')).toBe(true);
  });
});

describe('ErasureService', () => {
  it('throws NotFound when user has no records — nothing committed', async () => {
    const { dataSource, committed } = makeDataSource({ affected: 0 });
    const service = new ErasureService(dataSource, makeVault());

    await expect(service.eraseUser('ghost-user', 'admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(committed.tombstones).toEqual([]);
  });

  it('pseudonymizes records and stores the tombstone in the same transaction', async () => {
    const { dataSource, committed } = makeDataSource({
      affected: 2,
      references: 1,
    });
    const service = new ErasureService(dataSource, makeVault());

    const result = (await service.eraseUser('user-123', 'admin-dpo')) as {
      tombstone: Record<string, unknown>;
      referencesPseudonymized: number;
    };

    const pseudonym = pseudonymize(KEY, 'user-123');
    expect(result.tombstone).toMatchObject({
      userId: 'user-123',
      requestedBy: 'admin-dpo',
      recordsDeleted: 2,
      method: 'PSEUDONYMIZE',
      pseudonym,
    });
    expect(result.referencesPseudonymized).toBe(1);
    expect(result.tombstone.hash as string).toMatch(/^[a-f0-9]{64}$/);
    expect(committed.updated).toBe(2);
    expect(committed.tombstones).toHaveLength(1);
    expect(committed.tombstones[0]).toMatchObject({
      userId: 'user-123',
      method: 'PSEUDONYMIZE',
      pseudonym,
      hash: result.tombstone.hash,
    });
    expect(committed.tombstones[0].deletedAt).toBeInstanceOf(Date);
  });

  it('references in other rows alone are not a user → NotFound, references rolled back', async () => {
    const { dataSource, committed } = makeDataSource({
      affected: 0,
      references: 3,
    });
    const service = new ErasureService(dataSource, makeVault());

    await expect(service.eraseUser('user-7', 'admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(committed.tombstones).toEqual([]);
  });

  it('cannot record the tombstone → the erasure is rolled back (never "erased without proof")', async () => {
    const { dataSource, committed } = makeDataSource({
      affected: 3,
      insertFails: true,
    });
    const service = new ErasureService(dataSource, makeVault());

    await expect(service.eraseUser('user-9', 'admin')).rejects.toThrow(
      'insert failed',
    );
    expect(committed.updated).toBe(0);
    expect(committed.tombstones).toEqual([]);
  });

  it('no pseudonym key in Vault → 503, never falls back to deleting', async () => {
    const { dataSource, committed } = makeDataSource({ affected: 1 });
    const service = new ErasureService(dataSource, makeVault(null));

    await expect(service.eraseUser('user-1', 'admin')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(committed.updated).toBe(0);
  });

  it('rejects a userId that is already a pseudonym', async () => {
    const { dataSource } = makeDataSource({ affected: 1 });
    const service = new ErasureService(dataSource, makeVault());

    await expect(
      service.eraseUser(pseudonymize(KEY, 'u'), 'admin'),
    ).rejects.toThrow(BadRequestException);
  });

  it('updates (never deletes) AuditAccess, then inserts ErasureLog', async () => {
    const calls: any[] = [];
    const dataSource = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          update: (e: unknown, w: unknown, v: unknown) => {
            calls.push(['update', e, w, v]);
            return Promise.resolve({ affected: 1 });
          },
          query: (sql: string, params: unknown[]) => {
            calls.push(['query', sql.trim().split(/\s+/)[0], params]);
            return Promise.resolve([[], 0]);
          },
          insert: (e: unknown) => {
            calls.push(['insert', e]);
            return Promise.resolve({});
          },
          delete: () => {
            throw new Error('audit rows must not be deleted (PCI 10.5.1)');
          },
        } as unknown as EntityManager),
    } as unknown as DataSource;

    await new ErasureService(dataSource, makeVault()).eraseUser('u1', 'admin');

    const p = pseudonymize(KEY, 'u1');
    expect(calls).toEqual([
      [
        'update',
        AuditAccess,
        { userId: 'u1' },
        { userId: p, username: null, ipAddress: null },
      ],
      ['query', 'UPDATE', [resourcePattern('u1'), p]],
      ['insert', ErasureLog],
    ]);
  });
});
