import { Repository } from 'typeorm';
import { IntegrityService } from './integrity.service';
import { MerkleService } from './service/merkle.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Log } from '../logs/entities/log.entity';
import { Batch } from '../logs/entities/batch.entity';
import { Alert } from '../alerts/entities/alert.entity';
import { LogBatchMapping } from '../logs/entities/log-batch-mapping.entity';

/**
 * listBatches กับ IF_MODE — active โชว์ผลจำแนก Isolation Forest, calibrating ซ่อน (ifAnomaly null)
 * ifMode อ่านตอน construct → ต้องตั้ง process.env.IF_MODE ก่อนสร้าง service
 */
const ROW = {
  id: 'b1',
  merkle_root: 'abcd',
  tx_hash: null,
  block_number: null,
  status: 'CONFIRMED',
  log_count: 24,
  sealed_at: new Date('2026-10-16T04:17:00Z'),
  confirmed_at: null,
  if_anomaly: true,
  if_score: -0.23,
  if_reason: 'batch ผิดปกติ (Isolation Forest): IP ต้นทาง 2 IP',
  if_scored_at: new Date('2026-10-16T04:17:06Z'),
  has_snapshot: true,
  total: 1,
};

function makeService(): IntegrityService {
  const batchesRepo = {
    query: jest.fn().mockResolvedValue([ROW]),
  } as unknown as Repository<Batch>;
  return new IntegrityService(
    {} as Repository<Log>,
    batchesRepo,
    {} as Repository<Alert>,
    {} as Repository<LogBatchMapping>,
    {} as MerkleService,
    {} as BlockchainService,
  );
}

describe('IntegrityService.listBatches — IF_MODE', () => {
  const orig = process.env.IF_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.IF_MODE;
    else process.env.IF_MODE = orig;
  });

  it('active: exposes the Isolation Forest verdict', async () => {
    delete process.env.IF_MODE;
    const r = await makeService().listBatches({});
    expect(r.items[0]).toMatchObject({
      ifStatus: 'active',
      ifAnomaly: true,
      ifScore: -0.23,
      ifReason: expect.stringContaining('Isolation Forest') as unknown,
    });
    expect(r.items[0].ifScoredAt).toBeInstanceOf(Date);
  });

  it('calibrating: hides the verdict (ifAnomaly/score/reason null) but keeps ifStatus + ifScoredAt', async () => {
    process.env.IF_MODE = 'calibrating';
    const r = await makeService().listBatches({});
    expect(r.items[0]).toMatchObject({
      ifStatus: 'calibrating',
      ifAnomaly: null,
      ifScore: null,
      ifReason: null,
    });
    // ยังบอกได้ว่าประเมินไปแล้วเมื่อไหร่ (เก็บไว้ retrain) — แค่ไม่เปิดเผยคำตัดสิน
    expect(r.items[0].ifScoredAt).toBeInstanceOf(Date);
  });
});
