import { Logger } from '@nestjs/common';
import { Repository } from 'typeorm';
import { Batch } from '../logs/entities/batch.entity';
import { MetricsService } from './metrics.service';

type Row = { status: string; n: string; oldest: string | null };

/** repo ปลอมที่ตอบ query ของ collectBatchStats — rows ชุดถัดไปมาจาก next */
function makeRepo(next: () => Promise<Row[]>) {
  const qb = {
    select: () => qb,
    addSelect: () => qb,
    groupBy: () => qb,
    getRawMany: next,
  };
  return {
    createQueryBuilder: () => qb,
  } as unknown as Repository<Batch>;
}

describe('MetricsService — batch status gauges', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('exposes count + oldest age per status (Postgres returns numerics as strings)', async () => {
    const query = jest.fn(() =>
      Promise.resolve([
        { status: 'CONFIRMED', n: '19', oldest: '600000.5' },
        { status: 'UNVERIFIED', n: '1', oldest: '4000' },
      ]),
    );
    const svc = new MetricsService(makeRepo(query));

    const out = await svc.getMetrics();

    // สอง gauge ใช้ query เดียวกันต่อ 1 scrape
    expect(query).toHaveBeenCalledTimes(1);

    expect(out).toContain('logchain_batches{status="CONFIRMED"} 19');
    expect(out).toContain('logchain_batches{status="UNVERIFIED"} 1');
    expect(out).toContain(
      'logchain_batch_oldest_age_seconds{status="UNVERIFIED"} 4000',
    );
  });

  it('DB down → /metrics still renders (no batch series) and warns once, not every scrape', async () => {
    const svc = new MetricsService(
      makeRepo(() => Promise.reject(new Error('connection terminated'))),
    );

    const out = await svc.getMetrics();
    await svc.getMetrics();

    // metric อื่นยังอยู่ = scrape ไม่พัง = ServiceDown ไม่เด้งหลอก
    expect(out).toContain('logchain_logs_ingested_total');
    expect(out).not.toMatch(/logchain_batches\{/);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a status that disappears is dropped, not left at its old value', async () => {
    const batches: Row[][] = [
      [{ status: 'UNVERIFIED', n: '1', oldest: '4000' }],
      [{ status: 'CONFIRMED', n: '20', oldest: '600000' }],
    ];
    const svc = new MetricsService(
      makeRepo(() => Promise.resolve(batches.shift() ?? [])),
    );

    await svc.getMetrics();
    const out = await svc.getMetrics();

    expect(out).not.toContain('status="UNVERIFIED"');
    expect(out).toContain('logchain_batches{status="CONFIRMED"} 20');
  });
});
