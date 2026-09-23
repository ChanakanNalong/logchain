import { NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ErasureService } from './erasure.service';
import { AuditAccess } from '../audit/entities/audit-access.entity';
import { ErasureLog } from './entities/erasure-log.entity';

/**
 * DataSource ปลอม: transaction() รัน callback กับ manager ปลอม · callback โยน = rollback
 * (เก็บ "สิ่งที่ commit แล้ว" แยก ให้เทสต์ดูได้ว่า rollback ทิ้งการลบจริง)
 */
function makeDataSource(opts: { affected: number; insertFails?: boolean }) {
  const committed = { deleted: 0, tombstones: [] as any[] };
  const dataSource = {
    transaction: async (cb: (m: EntityManager) => Promise<unknown>) => {
      const pending = { deleted: 0, tombstones: [] as any[] };
      const manager = {
        delete: jest.fn(() => {
          pending.deleted = opts.affected;
          return Promise.resolve({ affected: opts.affected });
        }),
        insert: jest.fn((_entity: unknown, row: unknown) => {
          if (opts.insertFails)
            return Promise.reject(new Error('insert failed'));
          pending.tombstones.push(row);
          return Promise.resolve({});
        }),
      } as unknown as EntityManager;
      const result = await cb(manager); // โยน = ไม่ commit
      committed.deleted += pending.deleted;
      committed.tombstones.push(...pending.tombstones);
      return result;
    },
  } as unknown as DataSource;
  return { dataSource, committed };
}

describe('ErasureService', () => {
  it('throws NotFound when user has no records — nothing committed', async () => {
    const { dataSource, committed } = makeDataSource({ affected: 0 });
    const service = new ErasureService(dataSource);

    await expect(service.eraseUser('ghost-user', 'admin')).rejects.toThrow(
      NotFoundException,
    );
    expect(committed.tombstones).toEqual([]);
  });

  it('erases records and stores the tombstone in the same transaction', async () => {
    const { dataSource, committed } = makeDataSource({ affected: 2 });
    const service = new ErasureService(dataSource);

    const result: any = await service.eraseUser('user-123', 'admin-dpo');

    expect(result.tombstone).toMatchObject({
      userId: 'user-123',
      requestedBy: 'admin-dpo',
      recordsDeleted: 2,
    });
    expect(result.tombstone.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(committed.deleted).toBe(2);
    expect(committed.tombstones).toHaveLength(1);
    expect(committed.tombstones[0]).toMatchObject({
      userId: 'user-123',
      requestedBy: 'admin-dpo',
      recordsDeleted: 2,
      hash: result.tombstone.hash,
    });
    expect(committed.tombstones[0].deletedAt).toBeInstanceOf(Date);
  });

  it('cannot record the tombstone → the erasure is rolled back (never "deleted without proof")', async () => {
    const { dataSource, committed } = makeDataSource({
      affected: 3,
      insertFails: true,
    });
    const service = new ErasureService(dataSource);

    await expect(service.eraseUser('user-9', 'admin')).rejects.toThrow(
      'insert failed',
    );
    expect(committed.deleted).toBe(0);
    expect(committed.tombstones).toEqual([]);
  });

  it('uses the entities it claims to (AuditAccess delete, ErasureLog insert)', async () => {
    const calls: any[] = [];
    const dataSource = {
      transaction: (cb: (m: EntityManager) => Promise<unknown>) =>
        cb({
          delete: (e: unknown, w: unknown) => {
            calls.push(['delete', e, w]);
            return Promise.resolve({ affected: 1 });
          },
          insert: (e: unknown) => {
            calls.push(['insert', e]);
            return Promise.resolve({});
          },
        } as unknown as EntityManager),
    } as unknown as DataSource;

    await new ErasureService(dataSource).eraseUser('u1', 'admin');

    expect(calls).toEqual([
      ['delete', AuditAccess, { userId: 'u1' }],
      ['insert', ErasureLog],
    ]);
  });
});
