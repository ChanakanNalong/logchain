import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';
import { computeRawHash } from '../logs/services/log-hash';

/**
 * seal ต้องทำงานได้โดยไม่ต้องมี blockchain
 *
 * เดิม sealBatch() return ทันทีถ้า blockchain ไม่พร้อม ผลคือคนที่ clone repo ไปรัน
 * โดยไม่ตั้ง CONTRACT_ADDRESS/private key จะไม่ได้ batch สักก้อน แปลว่าไม่มี
 * Merkle root, ไม่มี per-log proof, ไม่มี tamper detection — ฟีเจอร์ M2 หายทั้งชุด
 * ทั้งที่ไม่มีอะไรในนั้นต้องพึ่ง chain จริง ๆ เลย
 */

function makeLog(id: string, createdAt: Date, message = `log ${id}`) {
  const row = {
    id,
    source: 'unit-test',
    sourceIp: null,
    eventType: 'AUTH_FAILURE',
    severity: 'INFO',
    message,
    classification: 'INTERNAL',
    cdeScope: false,
    createdAt,
  };
  return { ...row, rawHash: computeRawHash(row) };
}

function applyOrder<T>(rows: T[], order?: Record<string, 'ASC' | 'DESC'>): T[] {
  if (!order) return rows;
  const keys = Object.keys(order);
  return [...rows].sort((a: any, b: any) => {
    for (const k of keys) {
      const dir = order[k] === 'DESC' ? -1 : 1;
      if (a[k] < b[k]) return -1 * dir;
      if (a[k] > b[k]) return 1 * dir;
    }
    return 0;
  });
}

describe('IntegrityService — seal แยกจาก anchor', () => {
  let service: IntegrityService;
  let logsStore: any[];
  let mappingStore: any[];
  let batchStore: any[];
  let alertSaves: any[];
  let onChain: Map<string, string>;
  let blockchain: any;

  beforeEach(async () => {
    const t = new Date('2026-09-22T00:00:00.000Z');
    logsStore = [makeLog('a', t), makeLog('b', t), makeLog('c', t)];
    mappingStore = [];
    batchStore = [];
    alertSaves = [];
    onChain = new Map();

    const logsRepo = {
      find: jest.fn(async (opts: any = {}) => {
        let rows = [...logsStore];
        const idOp = opts.where?.id;
        if (idOp && typeof idOp === 'object' && idOp.type === 'in') {
          rows = rows.filter((r) => idOp.value.includes(r.id));
        }
        rows = applyOrder(rows, opts.order);
        if (opts.take) rows = rows.slice(0, opts.take);
        return rows;
      }),
      findOneBy: jest.fn(
        async ({ id }: any) => logsStore.find((l) => l.id === id) ?? null,
      ),
    };

    const mappingRepo = {
      find: jest.fn(async (opts: any = {}) => {
        let rows = [...mappingStore];
        if (opts.where?.batchId)
          rows = rows.filter((m) => m.batchId === opts.where.batchId);
        return rows;
      }),
      findOneBy: jest.fn(
        async ({ logId }: any) =>
          mappingStore.find((m) => m.logId === logId) ?? null,
      ),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (val: any) => {
        const arr = Array.isArray(val) ? val : [val];
        mappingStore.push(...arr.map((m: any) => ({ ...m })));
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
      findOneBy: jest.fn(
        async ({ id }: any) => batchStore.find((b) => b.id === id) ?? null,
      ),
    };

    const alertsRepo = {
      findOne: jest.fn(
        async ({ where }: any) =>
          alertSaves.find(
            (a: any) =>
              a.batchId === where.batchId &&
              a.alertType === where.alertType &&
              (where.status === undefined || a.status === where.status),
          ) ?? null,
      ),
      create: jest.fn((dto: any) => dto),
      save: jest.fn(async (dto: any) => {
        alertSaves.push(dto);
        return dto;
      }),
      update: jest.fn(async (where: any, patch: any) => {
        const hit = alertSaves.filter(
          (a: any) =>
            a.batchId === where.batchId &&
            a.alertType === where.alertType &&
            (where.status === undefined || a.status === where.status),
        );
        hit.forEach((a: any) => Object.assign(a, patch));
        return { affected: hit.length };
      }),
    };

    // เริ่มต้น "ไม่มี blockchain" — สภาพเดียวกับคนที่เพิ่ง clone repo มารัน
    blockchain = {
      ready: false,
      storeRoot: jest.fn(async (batchId: string, root: string) => {
        onChain.set(batchId, root.startsWith('0x') ? root : '0x' + root);
        return { txHash: '0xtx', blockNumber: 42, confirmed: true };
      }),
      checkRoot: jest.fn(async (batchId: string, root: string) => {
        const stored = onChain.get(batchId);
        const expected = (
          root.startsWith('0x') ? root : '0x' + root
        ).toLowerCase();
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
        MerkleService, // ของจริง — ห้าม mock การ hash
        { provide: BlockchainService, useValue: blockchain },
        { provide: getRepositoryToken(Log), useValue: logsRepo },
        { provide: getRepositoryToken(Batch), useValue: batchesRepo },
        { provide: getRepositoryToken(Alert), useValue: alertsRepo },
        { provide: getRepositoryToken(LogBatchMapping), useValue: mappingRepo },
      ],
    }).compile();

    service = module.get(IntegrityService);
  });

  it('seal ได้แม้ blockchain ไม่พร้อม — ได้ SEALED พร้อม mapping ครบ', async () => {
    const batch = await service.sealBatch();

    expect(batch).not.toBeNull();
    expect(batch!.status).toBe('SEALED');
    expect(batch!.merkleRoot).toHaveLength(64);
    expect(batch!.txHash).toBeUndefined();
    expect(blockchain.storeRoot).not.toHaveBeenCalled();

    // mapping ต้องถูกเขียน ไม่งั้น proof/verify รอบถัดไปคำนวณจาก leaf ว่าง
    expect(mappingStore.map((m) => m.logId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('per-log proof ใช้ได้กับ batch ที่ยังไม่ anchor', async () => {
    await service.sealBatch();

    const result = await service.getProofForLog('b');

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(result!.batch.status).toBe('SEALED');
  });

  it('จับ tamper บน batch ที่ยังไม่ anchor ได้ (ไม่ต้องใช้ chain)', async () => {
    const batch = await service.sealBatch();
    expect(batch!.status).toBe('SEALED');

    // แก้เนื้อ log โดยไม่แตะ raw_hash — เคสที่ Merkle root อย่างเดียวจับไม่ได้
    logsStore.find((l) => l.id === 'b').message = 'ถูกแก้หลัง seal';

    await service.verifyAllBatches();

    expect(batch!.status).toBe('TAMPERED');
    expect(alertSaves).toHaveLength(1);
    expect(alertSaves[0].alertType).toBe('INTEGRITY_TAMPERED');
    expect(alertSaves[0].detail.modifiedLogIds).toEqual(['b']);
    // ไม่ได้เทียบกับ chain จึงต้องเป็น null ไม่ใช่ค่าหลอก
    expect(alertSaves[0].detail.onChainRoot).toBeNull();
  });

  it('จับได้เมื่อ log ถูกถอดออกจาก batch (root ที่คำนวณใหม่ไม่ตรง root ตอน seal)', async () => {
    const batch = await service.sealBatch();

    // ลบ mapping ของ log หนึ่งตัว = ชุด leaf เปลี่ยน แต่ทุก row ยังตรง hash ตัวเอง
    // ต้อง splice ทิ้งในตัวเดิม ไม่ใช่ reassign — mock ของ repo ถือ reference
    // ของ array ก้อนนี้ไว้ผ่าน closure
    const drop = mappingStore.findIndex((m) => m.logId === 'c');
    mappingStore.splice(drop, 1);

    await service.verifyAllBatches();

    expect(batch!.status).toBe('TAMPERED');
    expect(alertSaves[0].detail.modifiedLogIds).toEqual([]);
  });

  it('batch ที่ยังสะอาดต้องคง SEALED ไว้ ไม่เลื่อนเป็น CONFIRMED เอง', async () => {
    const batch = await service.sealBatch();

    for (let i = 0; i < 3; i++) await service.verifyAllBatches();

    expect(batch!.status).toBe('SEALED');
    expect(alertSaves).toHaveLength(0);
  });

  it('พอ blockchain พร้อม batch ที่ค้าง SEALED ถูก anchor ย้อนหลังเป็น CONFIRMED', async () => {
    const batch = await service.sealBatch();
    const sealedRoot = batch!.merkleRoot;

    blockchain.ready = true;
    await service.anchorSealedBatches();

    expect(batch!.status).toBe('CONFIRMED');
    expect(batch!.txHash).toBe('0xtx');
    expect(batch!.confirmedAt).toBeInstanceOf(Date);
    // root ต้องเป็นตัวเดิมที่ปิดไว้ตอน seal ห้าม recompute
    expect(batch!.merkleRoot).toBe(sealedRoot);
    expect(blockchain.storeRoot).toHaveBeenCalledWith('batch-0', '0x' + sealedRoot);

    // verify รอบถัดไปเทียบกับ chain ได้แล้วและต้องผ่าน
    await service.verifyAllBatches();
    expect(batch!.status).toBe('CONFIRMED');
  });

  it('anchor ย้อนหลังไม่สำเร็จต้องค้าง SEALED ไม่ใช่ FAILED', async () => {
    const batch = await service.sealBatch();

    blockchain.ready = true;
    blockchain.storeRoot = jest.fn(async () => {
      throw new Error('network error: RPC ไม่ตอบ');
    });

    await service.anchorSealedBatches();

    // batch ใบนี้มี mapping ครบและ verify แบบ local ได้ปกติ — ตั้ง FAILED
    // จะทำให้ stats ตัดออกจากตัวหารทั้งที่ไม่มีอะไรผิด
    expect(batch!.status).toBe('SEALED');
  });
});
