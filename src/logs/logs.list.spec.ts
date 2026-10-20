import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { LogService } from './logs.service';
import { Log } from './entities/log.entity';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { PiiMaskingService } from './services/pii-masking.service';
import { MetricsService } from '../metrics/metrics.service';

/**
 * GET /logs — parameter ที่ส่งเข้า SQL + แปลงแถวเป็น item
 * SQL จริง (JOIN / COUNT OVER / ILIKE) ทดสอบกับ Postgres ใน test/log-onchain-status.integration.spec.ts
 */
describe('LogService.list / findOne', () => {
  let query: jest.Mock;
  let findOneBy: jest.Mock;
  let service: LogService;

  beforeEach(() => {
    query = jest.fn(() => Promise.resolve([]));
    findOneBy = jest.fn(() => Promise.resolve(null));
    service = new LogService(
      { query, findOneBy } as unknown as Repository<Log>,
      {} as KafkaProducerService,
      {} as PiiMaskingService,
      {} as MetricsService,
    );
  });

  const params = (n = 0) => (query.mock.calls[n] as [string, unknown[]])[1];

  it('defaults: limit 100, offset 0, no filters', async () => {
    const page = await service.list({});
    // [source, severity, eventType, qMessage, ipFull, ipPrefix, ipMasked, limit, offset]
    expect(params()).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      100,
      0,
    ]);
    expect(page).toEqual({ items: [], total: 0, limit: 100, offset: 0 });
  });

  it('comma-separated filters become arrays; blanks are dropped', async () => {
    await service.list({
      source: 'vps-01, web-01,,',
      severity: 'WARNING,CRITICAL',
      eventType: ' SYSLOG ',
      limit: 20,
      offset: 40,
    });
    expect(params()).toEqual([
      ['vps-01', 'web-01'],
      ['WARNING', 'CRITICAL'],
      ['SYSLOG'],
      null,
      null,
      null,
      null,
      20,
      40,
    ]);
  });

  it('q = full IPv4: searches source_id exact + masked form in message', async () => {
    await service.list({ q: '49.229.84.104' });
    const p = params();
    expect(p[3]).toBe('%49.229.84.104%'); // message ILIKE (เดิม)
    expect(p[4]).toBe('49.229.84.104'); // host(source_id) LIKE (ตรงตัว)
    expect(p[5]).toBeNull(); // ไม่ใช่ prefix
    expect(p[6]).toBe('%49.229.84.xxx%'); // masked ใน message
    const sql = (query.mock.calls[0] as [string])[0];
    expect(sql).toMatch(/host\(l\.source_id\) LIKE \$5/);
    expect(sql).toMatch(/host\(l\.source_id\) LIKE \$6/);
  });

  it('q = partial IP: prefix match on source_id only', async () => {
    await service.list({ q: '49.229' });
    const p = params();
    expect(p[4]).toBeNull(); // ไม่ใช่ IP เต็ม
    expect(p[5]).toBe('49.229%'); // prefix
    expect(p[6]).toBeNull(); // ไม่มี masked (เฉพาะ IP เต็ม)
  });

  it('q = non-IP text: ip params stay null (message search เหมือนเดิม)', async () => {
    await service.list({ q: 'login failed' });
    const p = params();
    expect(p[3]).toBe('%login failed%');
    expect([p[4], p[5], p[6]]).toEqual([null, null, null]);
  });

  it('maps matched_masked_ip → matchedMaskedIp', async () => {
    delete process.env.BLOCKCHAIN_EXPLORER_TX_URL;
    query.mockResolvedValueOnce([
      {
        id: 'l1',
        created_at: '2026-10-15T09:39:58.004Z',
        source: 'web-proxy',
        source_ip: '49.229.84.7',
        event_type: 'HTTP_ACCESS',
        severity: 'INFO',
        message: 'GET / from 49.229.84.xxx',
        classification: 'INTERNAL',
        cde_scope: false,
        retention_days: 365,
        raw_hash: 'h',
        batch_id: null,
        batch_status: null,
        tx_hash: null,
        block_number: null,
        matched_masked_ip: true,
        total: '1',
      },
    ]);
    const page = await service.list({ q: '49.229.84.104' });
    expect(page.items[0].matchedMaskedIp).toBe(true);
  });

  it('q is a literal substring: % _ and \\ are escaped for ILIKE', async () => {
    await service.list({ q: '50%_off\\x' });
    expect(params()[3]).toBe('%50\\%\\_off\\\\x%');
    expect((query.mock.calls[0] as [string])[0]).toMatch(
      /ILIKE \$4 ESCAPE '\\'/,
    );
  });

  it('maps rows, total from COUNT OVER, bigint block number, explorer link', async () => {
    delete process.env.BLOCKCHAIN_EXPLORER_TX_URL;
    query.mockResolvedValueOnce([
      {
        id: 'l1',
        created_at: '2026-10-15T09:39:58.004Z',
        source: 'web-01',
        source_ip: '198.51.100.9',
        event_type: 'WEB_REQUEST',
        severity: 'INFO',
        message: 'm',
        classification: 'INTERNAL',
        cde_scope: false,
        retention_days: 365,
        raw_hash: 'h',
        batch_id: 'b1',
        batch_status: 'CONFIRMED',
        tx_hash: '0xabc',
        block_number: '28451107',
        total: '37',
      },
      {
        id: 'l2',
        created_at: '2026-10-15T09:41:07.512Z',
        source: 'vps-01',
        source_ip: null,
        event_type: 'SYSLOG',
        severity: 'WARNING',
        message: 'm2',
        classification: 'INTERNAL',
        cde_scope: false,
        retention_days: 365,
        raw_hash: 'h2',
        batch_id: null,
        batch_status: null,
        tx_hash: null,
        block_number: null,
        total: '37',
      },
    ]);
    const page = await service.list({ limit: 2 });
    expect(page.total).toBe(37);
    expect(page.items[0]).toMatchObject({
      id: 'l1',
      createdAt: new Date('2026-10-15T09:39:58.004Z'),
      batchStatus: 'CONFIRMED',
      blockNumber: 28451107,
      polygonscanUrl: 'https://amoy.polygonscan.com/tx/0xabc',
    });
    expect(page.items[1]).toMatchObject({
      batchId: null,
      batchStatus: null,
      txHash: null,
      blockNumber: null,
      polygonscanUrl: null,
    });
  });

  it('an empty page past the end still reports the real total', async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: '12' }]);
    const page = await service.list({ offset: 500, source: 'vps-01' });
    expect(page.total).toBe(12);
    expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual([
      ['vps-01'],
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('findOne → 404 when missing', async () => {
    await expect(
      service.findOne('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
