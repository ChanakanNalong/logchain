import { Test } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';

/**
 * บน Hardhat local node chain state หายทุกครั้งที่ restart — root ไม่เคยชนกัน
 * บน Amoy state อยู่ถาวร storeRoot จึง revert ด้วย
 *   require(roots[id] == bytes32(0), "Root already exists")
 * ได้จริง (retry, tx ที่ confirm ทีหลัง, race ระหว่าง checkRoot กับ storeRoot)
 *
 * เคสนั้น root อยู่บน chain ครบแล้ว = งานสำเร็จ ห้ามกลายเป็น batch FAILED
 */

/** error ทรงเดียวกับที่ ethers v6 โยนออกมาเวลา require() revert */
function revertError(reason: string) {
  return Object.assign(new Error(`execution reverted: "${reason}"`), {
    code: 'CALL_EXCEPTION',
    action: 'estimateGas',
    reason,
    shortMessage: `execution reverted: "${reason}"`,
    revert: { name: 'Error', signature: 'Error(string)', args: [reason] },
  });
}

describe('IntegrityService — chain write errors', () => {
  let service: IntegrityService;
  let logsStore: any[];
  let mappingStore: any[];
  let batchStore: any[];
  let onChain: Map<string, string>;
  let storeRootImpl: (batchId: string, root: string) => Promise<any>;
  let errorSpy: jest.SpyInstance;

  beforeEach(async () => {
    const t = new Date('2026-08-28T21:00:00.000Z');
    logsStore = [
      { id: 'a', rawHash: 'aa'.repeat(32), createdAt: t },
      { id: 'b', rawHash: 'bb'.repeat(32), createdAt: t },
    ];
    mappingStore = [];
    batchStore = [];
    onChain = new Map();

    // default: anchor สำเร็จตามปกติ — แต่ละ test override ได้
    storeRootImpl = async (batchId, root) => {
      onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
      return { txHash: '0xtx', blockNumber: 1 };
    };

    const logsRepo = {
      find: jest.fn(async (opts: any = {}) => {
        let rows = [...logsStore];
        const idOp = opts.where?.id;
        if (idOp && typeof idOp === 'object' && idOp.type === 'in') {
          rows = rows.filter((r) => (idOp.value as string[]).includes(r.id));
        }
        if (opts.take) rows = rows.slice(0, opts.take);
        return rows;
      }),
      findOneBy: jest.fn(async ({ id }: any) => logsStore.find((l) => l.id === id) ?? null),
    };

    const mappingRepo = {
      find: jest.fn(async (opts: any = {}) => {
        const bid = opts.where?.batchId;
        return bid ? mappingStore.filter((m) => m.batchId === bid) : [...mappingStore];
      }),
      findOneBy: jest.fn(async ({ logId }: any) =>
        mappingStore.find((m) => m.logId === logId) ?? null,
      ),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (val: any) => {
        for (const m of Array.isArray(val) ? val : [val]) mappingStore.push(m);
        return val;
      }),
    };

    let batchSeq = 0;
    const batchesRepo = {
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (batch: any) => {
        if (!batch.id) batch.id = `batch-${batchSeq++}`;
        if (!batchStore.includes(batch)) batchStore.push(batch);
        return batch;
      }),
      find: jest.fn(async (opts: any = {}) => {
        const clauses = Array.isArray(opts.where) ? opts.where : [opts.where];
        return batchStore.filter((b) =>
          clauses.some((c: any) => !c?.status || c.status === b.status),
        );
      }),
      findOneBy: jest.fn(async ({ id }: any) => batchStore.find((b) => b.id === id) ?? null),
    };

    const alertsRepo = {
      findOne: jest.fn(async () => null),
      create: jest.fn((dto: any) => dto),
      save: jest.fn(async (dto: any) => dto),
    };

    const blockchain = {
      ready: true,
      storeRoot: jest.fn((batchId: string, root: string) => storeRootImpl(batchId, root)),
      checkRoot: jest.fn(async (batchId: string, root: string) => {
        const stored = onChain.get(batchId);
        const expected = (root.startsWith('0x') ? root : '0x' + root).toLowerCase();
        if (!stored) return { result: 'MISSING', onChainRoot: '0x0' };
        return {
          result: stored.toLowerCase() === expected ? 'MATCH' : 'MISMATCH',
          onChainRoot: stored,
        };
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        IntegrityService,
        MerkleService,
        { provide: BlockchainService, useValue: blockchain },
        { provide: getRepositoryToken(Log), useValue: logsRepo },
        { provide: getRepositoryToken(Batch), useValue: batchesRepo },
        { provide: getRepositoryToken(Alert), useValue: alertsRepo },
        { provide: getRepositoryToken(LogBatchMapping), useValue: mappingRepo },
      ],
    }).compile();

    service = module.get(IntegrityService);
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('sealBatch', () => {
    it('confirms — never FAILED — when the same root is already anchored on chain', async () => {
      // จำลอง Amoy: root ของ batch นี้ถูก anchor ไปแล้ว storeRoot จึง revert
      storeRootImpl = async (batchId, root) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        throw revertError('Root already exists');
      };

      const batch = await service.sealBatch();

      expect(batch).not.toBeNull();
      expect(batch!.status).toBe('CONFIRMED');
      expect(batch!.status).not.toBe('FAILED');
    });

    it('writes the log→batch mapping so the same logs are not re-sealed every cron tick', async () => {
      storeRootImpl = async (batchId, root) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        throw revertError('Root already exists');
      };

      const batch = await service.sealBatch();

      expect(mappingStore.map((m) => m.logId).sort()).toEqual(['a', 'b']);
      expect(mappingStore.every((m) => m.batchId === batch!.id)).toBe(true);

      // รอบถัดไปไม่มี log ค้างแล้ว — ไม่เกิด batch ใหม่ (และไม่เกิด FAILED เพิ่ม)
      logsStore = [];
      expect(await service.sealBatch()).toBeNull();
      expect(batchStore.filter((b) => b.status === 'FAILED')).toHaveLength(0);
    });

    it('stays verifiable after adopting the existing root', async () => {
      storeRootImpl = async (batchId, root) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        throw revertError('Root already exists');
      };

      const batch = await service.sealBatch();
      await service.verifyAllBatches();

      expect(batch!.status).toBe('CONFIRMED'); // ไม่ไหลไป UNVERIFIED/TAMPERED
    });

    it('marks FAILED when a different root already occupies the batch id', async () => {
      // root คนละตัวใต้ batch id เดียวกัน = ผิดปกติจริง ไม่ใช่ retry ที่ไม่เป็นพิษเป็นภัย
      storeRootImpl = async (batchId) => {
        onChain.set(batchId, '0x' + 'de'.repeat(32));
        throw revertError('Root already exists');
      };

      const batch = await service.sealBatch();

      expect(batch!.status).toBe('FAILED');
    });

    it('still marks FAILED for a genuine chain error', async () => {
      storeRootImpl = async () => {
        throw revertError('Not authorized');
      };

      const batch = await service.sealBatch();

      expect(batch!.status).toBe('FAILED');
      // และต้องบอกสาเหตุที่แก้ได้จริง ไม่ใช่แค่ "failed to commit"
      const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('not the contract owner');
    });

    it('marks FAILED for a non-revert failure such as an RPC outage', async () => {
      storeRootImpl = async () => {
        throw Object.assign(new Error('could not detect network'), { code: 'NETWORK_ERROR' });
      };

      const batch = await service.sealBatch();

      expect(batch!.status).toBe('FAILED');
    });
  });

  describe('reanchorUnverified', () => {
    const prev = process.env.INTEGRITY_AUTO_REANCHOR;
    beforeEach(() => {
      process.env.INTEGRITY_AUTO_REANCHOR = 'true';
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.INTEGRITY_AUTO_REANCHOR;
      else process.env.INTEGRITY_AUTO_REANCHOR = prev;
    });

    it('treats "Root already exists" as done — no error, status untouched', async () => {
      // race: checkRoot เห็น MISSING แล้ว tx เก่าเพิ่ง confirm ก่อน storeRoot จะไปถึง
      batchStore.push({
        id: 'batch-x',
        merkleRoot: 'ab'.repeat(32),
        logCount: 2,
        status: 'UNVERIFIED',
      });
      storeRootImpl = async () => {
        throw revertError('Root already exists');
      };

      await service.reanchorUnverified();

      expect(batchStore[0].status).toBe('UNVERIFIED'); // ไม่ถูกเปลี่ยนเป็น FAILED
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('logs an error for any other re-anchor failure', async () => {
      batchStore.push({
        id: 'batch-y',
        merkleRoot: 'cd'.repeat(32),
        logCount: 2,
        status: 'UNVERIFIED',
      });
      storeRootImpl = async () => {
        throw revertError('Not authorized');
      };

      await service.reanchorUnverified();

      expect(batchStore[0].status).toBe('UNVERIFIED'); // ยังไม่ตั้ง FAILED อยู่ดี
      expect(errorSpy).toHaveBeenCalled();
    });
  });
});
