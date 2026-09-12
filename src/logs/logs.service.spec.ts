import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LogService } from './logs.service';
import { Log } from './entities/log.entity';
import { CreateLogDto } from './dto/create-log.dto';
import { PiiMaskingService } from './services/pii-masking.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  computeRawHash,
  isRawHashIntact,
  normalizeIp,
} from './services/log-hash';

/**
 * rawHash ต้องครอบทุก field ที่เป็นหลักฐาน
 * ถ้าครอบไม่ครบ คนที่เข้าถึง DB ได้จะแก้ severity/sourceIp/createdAt
 * แล้ว Merkle root ยังตรง = ระบบรายงาน CONFIRMED ทั้งที่ log ถูกบิดเบือน
 */
describe('LogService — rawHash coverage', () => {
  let service: LogService;
  let inserted: Log[];
  let published: Array<Record<string, unknown>>;

  const baseDto = (over: Partial<CreateLogDto> = {}): CreateLogDto => ({
    source: 'web-server-01',
    eventType: 'AUTH_FAILURE',
    severity: 'WARNING',
    message: 'Failed login attempt',
    classification: 'INTERNAL',
    ...over,
  });

  beforeEach(async () => {
    inserted = [];
    published = [];

    const repo = {
      create: jest.fn((dto: Partial<Log>): Partial<Log> => ({ ...dto })),
      insert: jest.fn((entity: Log) => {
        inserted.push(entity);
        return Promise.resolve({ identifiers: [{ id: entity.id }] });
      }),
      // ingest ต้องไม่เรียก save/update — ตาราง logs มี trigger บล็อก UPDATE
      save: jest.fn(() => {
        throw new Error('logs table is insert-only — save() must not be used');
      }),
      update: jest.fn(() => {
        throw new Error('IMMUTABLE_LOG: UPDATE not permitted on logs table');
      }),
    };

    const module = await Test.createTestingModule({
      providers: [
        LogService,
        PiiMaskingService, // real — masking ต้องไม่ถูก mock
        { provide: getRepositoryToken(Log), useValue: repo },
        {
          provide: KafkaProducerService,
          useValue: {
            publishLog: jest.fn((msg: Record<string, unknown>) => {
              published.push(msg);
              return Promise.resolve();
            }),
          },
        },
        {
          provide: MetricsService,
          useValue: {
            incrementPiiMasked: jest.fn(),
            incrementLogsIngested: jest.fn(),
            recordIngestDuration: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(LogService);
  });

  it('gives two logs with identical content different rawHash', async () => {
    const a = await service.ingest(baseDto());
    const b = await service.ingest(baseDto());

    // เนื้อเหมือนกันทุกอย่าง ต่างกันแค่ id/createdAt
    expect(b.source).toBe(a.source);
    expect(b.eventType).toBe(a.eventType);
    expect(b.message).toBe(a.message);
    expect(b.id).not.toBe(a.id);

    expect(b.rawHash).not.toBe(a.rawHash);
    expect(a.rawHash).toHaveLength(64);
  });

  it('writes the hash in the same INSERT — no UPDATE after insert', async () => {
    const saved = await service.ingest(baseDto());

    expect(inserted).toHaveLength(1);
    expect(inserted[0].rawHash).toBe(saved.rawHash);
    expect(inserted[0].id).toBe(saved.id);
    expect(inserted[0].createdAt).toBeInstanceOf(Date);
    expect(published[0].rawHash).toBe(saved.rawHash);
  });

  it('is deterministic — same input (id + createdAt included) always hashes the same', async () => {
    const saved = await service.ingest(
      baseDto({ sourceIp: '10.0.0.1', cdeScope: true }),
    );

    const recomputed = computeRawHash({
      id: saved.id,
      source: saved.source,
      sourceIp: saved.sourceIp,
      eventType: saved.eventType,
      severity: saved.severity,
      message: saved.message,
      classification: saved.classification,
      cdeScope: saved.cdeScope,
      createdAt: saved.createdAt,
    });

    expect(recomputed).toBe(saved.rawHash);
    // เรียกซ้ำอีกกี่ครั้งก็ต้องได้ค่าเดิม
    expect(computeRawHash({ ...saved })).toBe(saved.rawHash);
    expect(isRawHashIntact(saved)).toBe(true);
  });

  it('covers every evidence field — changing any one of them changes the hash', async () => {
    const saved = await service.ingest(baseDto({ sourceIp: '10.0.0.1' }));
    const tamperings: Array<Partial<Log>> = [
      { id: '00000000-0000-4000-8000-000000000000' },
      { source: 'other-host' },
      { sourceIp: '10.0.0.2' },
      { sourceIp: null },
      { eventType: 'AUTH_SUCCESS' },
      { severity: 'INFO' },
      { message: 'nothing to see here' },
      { classification: 'PUBLIC' },
      { cdeScope: true },
      { createdAt: new Date(saved.createdAt.getTime() - 3_600_000) },
    ];

    for (const change of tamperings) {
      const tampered = { ...saved, ...change };
      expect(computeRawHash(tampered)).not.toBe(saved.rawHash);
      // rawHash เดิมติดมากับ row ที่ถูกแก้ → ตรวจจับได้
      expect(isRawHashIntact({ ...tampered, rawHash: saved.rawHash })).toBe(
        false,
      );
    }
  });

  it('serializes a null sourceIp the same way every time', async () => {
    const a = await service.ingest(baseDto());
    expect(a.sourceIp).toBeNull();

    expect(computeRawHash({ ...a, sourceIp: null })).toBe(a.rawHash);
    expect(
      computeRawHash({ ...a, sourceIp: undefined as unknown as null }),
    ).toBe(a.rawHash);
    expect(normalizeIp(undefined)).toBeNull();
    expect(normalizeIp('')).toBeNull();
  });

  it('hashes the masked message only — the real PAN never reaches the hash', async () => {
    const a = await service.ingest(
      baseDto({ message: 'payment with card 4111 1111 1111 1111 failed' }),
    );
    const b = await service.ingest(
      baseDto({ message: 'payment with card 5555 4444 3333 2222 failed' }),
    );

    expect(a.message).toBe('payment with card [PAN] failed');
    expect(b.message).toBe(a.message);

    // hash ของ log ที่มี PAN ต้องไม่เปลี่ยนตามเลข PAN จริง
    // (id/createdAt ต่างกัน จึงเทียบที่ระดับ payload เดียวกัน)
    expect(computeRawHash({ ...b, id: a.id, createdAt: a.createdAt })).toBe(
      a.rawHash,
    );

    // และ hash ของข้อความดิบ (ยังมี PAN) ต้องไม่ใช่ค่าที่บันทึกไว้
    expect(
      computeRawHash({
        ...a,
        message: 'payment with card 4111 1111 1111 1111 failed',
      }),
    ).not.toBe(a.rawHash);
  });

  it('normalizes sourceIp so a re-read from Postgres still matches the hash', async () => {
    const saved = await service.ingest(
      baseDto({ sourceIp: '2001:0DB8:0000:0000:0000:0000:0000:0001' }),
    );

    // เก็บและ hash ด้วยรูปแบบย่อแบบเดียวกับที่ inet คืนกลับมา
    expect(saved.sourceIp).toBe('2001:db8::1');
    expect(isRawHashIntact({ ...saved, sourceIp: '2001:db8::1' })).toBe(true);
  });
});
