import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

const mockProducer = {
  connect: jest.fn(),
  send: jest.fn(),
  disconnect: jest.fn(),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    producer: () => mockProducer,
  })),
  CompressionTypes: { GZIP: 1 },
}));

// ต้อง import หลัง jest.mock
import { KafkaProducerService, LogEvent } from './kafka-producer.service';
import { PendingLog } from './entities/pending-log.entity';
import { Repository } from 'typeorm';

/**
 * บั๊กที่เทสนี้คุม: ของเดิม connect ครั้งเดียวตอน boot ถ้า broker ยังไม่พร้อม
 * (compose ยก backend ขึ้นก่อน Kafka) จะ "log publishing disabled" ถาวร
 * log เข้า DB ได้ปกติแต่ไม่ถึง logs.raw — detection ไม่เห็นอะไรเลยทั้ง run
 */
describe('KafkaProducerService — reconnect', () => {
  const event: LogEvent = {
    id: 'log-1',
    source: 'web-server-01',
    sourceIp: '203.0.113.77',
    eventType: 'AUTH_FAILURE',
    severity: 'WARNING',
    message: 'authentication failed',
    rawHash: 'h',
    cdeScope: false,
    createdAt: '2026-09-22T00:00:00Z',
  };

  /** query builder ของ INSERT ... ON CONFLICT DO NOTHING */
  interface InsertQbMock {
    insert: jest.Mock<InsertQbMock, []>;
    into: jest.Mock<InsertQbMock, []>;
    values: jest.Mock<InsertQbMock, [Partial<PendingLog>]>;
    orIgnore: jest.Mock<InsertQbMock, []>;
    execute: jest.Mock<Promise<object>, []>;
  }

  /** outbox ปลอม — เก็บแถวไว้ใน array ให้เทสอ่านได้ */
  function makePendingRepo() {
    const rows: PendingLog[] = [];
    const insertQb: InsertQbMock = {
      insert: jest.fn(() => insertQb),
      into: jest.fn(() => insertQb),
      values: jest.fn((v: Partial<PendingLog>) => {
        pendingRepo.inserted.push(v);
        return insertQb;
      }),
      orIgnore: jest.fn(() => insertQb),
      execute: jest.fn(() => Promise.resolve({})),
    };
    const pendingRepo = {
      rows,
      inserted: [] as Partial<PendingLog>[],
      createQueryBuilder: jest.fn(() => insertQb),
      find: jest.fn(() => Promise.resolve(rows.slice())),
      delete: jest.fn(({ logId }: { logId: string }) => {
        const i = rows.findIndex((r) => r.logId === logId);
        if (i >= 0) rows.splice(i, 1);
        return Promise.resolve({ affected: 1 });
      }),
    };
    return pendingRepo;
  }

  let pending: ReturnType<typeof makePendingRepo>;

  function fastService() {
    const overrides: Record<string, unknown> = {
      KAFKA_RECONNECT_BASE_MS: 1,
      KAFKA_RECONNECT_MAX_MS: 2,
      KAFKA_BROKERS: 'kafka-1:9092',
    };
    const cfg = {
      get: (key: string, def?: unknown) =>
        key in overrides ? overrides[key] : (def ?? ''),
    } as unknown as ConfigService;
    return new KafkaProducerService(
      cfg,
      pending as unknown as Repository<PendingLog>,
    );
  }

  async function until(fn: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error('timeout รอเงื่อนไขไม่สำเร็จ');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    pending = makePendingRepo();
    mockProducer.connect.mockResolvedValue(undefined);
    mockProducer.send.mockResolvedValue(undefined);
    mockProducer.disconnect.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  it('ต่อไม่ติดตอน boot แล้วลองใหม่จนติด — publish ได้หลังจากนั้น', async () => {
    mockProducer.connect
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(undefined);

    const svc = fastService();
    svc.onModuleInit();
    await until(() => mockProducer.connect.mock.calls.length === 3);
    await new Promise((r) => setTimeout(r, 5));

    await svc.publishLog(event);

    expect(mockProducer.send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'logs.raw' }),
    );
    await svc.onModuleDestroy();
  });

  it('ระหว่างยังต่อไม่ติด เก็บ log เข้าคิวแทนการทิ้ง และเตือนครั้งเดียว', async () => {
    mockProducer.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const svc = fastService();
    svc.onModuleInit();
    await svc.publishLog(event);
    await svc.publishLog({ ...event, id: 'log-2' });

    expect(mockProducer.send).not.toHaveBeenCalled();
    // บั๊กเดิม: return เฉย ๆ → log อยู่ใน DB แต่ detection ไม่เคยเห็น
    expect(pending.inserted.map((r) => r.logId)).toEqual(['log-1', 'log-2']);
    const queued = warn.mock.calls.filter(([m]) =>
      String(m).includes('เข้าคิวไว้ใน kafka_pending_logs'),
    );
    expect(queued).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('พอต่อติด ส่ง log ที่ค้างคิวตามไปตามลำดับ แล้วลบออกจากคิว', async () => {
    pending.rows.push(
      {
        logId: 'old-1',
        payload: { ...event, id: 'old-1' },
        queuedAt: new Date('2026-09-23T01:00:00Z'),
      },
      {
        logId: 'old-2',
        payload: { ...event, id: 'old-2' },
        queuedAt: new Date('2026-09-23T01:00:01Z'),
      },
    );

    const svc = fastService();
    svc.onModuleInit();
    await until(() => pending.rows.length === 0);

    const sentIds = mockProducer.send.mock.calls.map(
      ([arg]: [{ topic: string; messages: { value: string }[] }]) =>
        (JSON.parse(arg.messages[0].value) as LogEvent).id,
    );
    expect(sentIds).toEqual(['old-1', 'old-2']);
    expect(pending.delete).toHaveBeenCalledTimes(2);
    await svc.onModuleDestroy();
  });

  it('ส่งไม่สำเร็จและ DLQ ก็ไม่สำเร็จ — log ลงคิวแทนที่จะหาย', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    mockProducer.send.mockRejectedValue(new Error('broker down'));

    const svc = fastService();
    svc.onModuleInit();
    await until(() => mockProducer.connect.mock.calls.length === 1);
    await svc.publishLog(event);

    expect(pending.inserted.map((r) => r.logId)).toEqual(['log-1']);
    await svc.onModuleDestroy();
  });

  it('broker ล่มหลังต่อติดแล้ว — คิวถูก drain ตอน send สำเร็จอีกครั้ง ไม่ต้องรอ restart', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const svc = fastService();
    svc.onModuleInit();
    await until(() => mockProducer.connect.mock.calls.length === 1);

    // broker ล่ม: send + DLQ พังทั้งคู่ → log ลงคิว (kafkajs reconnect เอง ไม่ผ่าน connectLoop)
    mockProducer.send.mockRejectedValue(new Error('broker down'));
    await svc.publishLog(event);
    expect(pending.inserted.map((r) => r.logId)).toEqual(['log-1']);
    pending.rows.push({
      logId: 'log-1',
      payload: event,
      queuedAt: new Date('2026-09-23T02:00:00Z'),
    });

    // broker กลับมา: log ใบถัดไปส่งผ่าน แล้วต้องลากใบที่ค้างคิวตามไปด้วย
    mockProducer.send.mockResolvedValue(undefined);
    await svc.publishLog({ ...event, id: 'log-2' });
    await until(() => pending.rows.length === 0);

    expect(pending.delete).toHaveBeenCalledWith({ logId: 'log-1' });
    await svc.onModuleDestroy();
  });

  it('shutdown ระหว่างรอ backoff ไม่ค้าง และไม่ disconnect ถ้ายังไม่เคยต่อติด', async () => {
    mockProducer.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const cfg = {
      get: (key: string, def?: unknown) =>
        key === 'KAFKA_RECONNECT_BASE_MS' ? 60000 : (def ?? ''),
    } as unknown as ConfigService;
    const svc = new KafkaProducerService(
      cfg,
      pending as unknown as Repository<PendingLog>,
    );
    svc.onModuleInit();
    await until(() => mockProducer.connect.mock.calls.length === 1);

    const started = Date.now();
    await svc.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(mockProducer.disconnect).not.toHaveBeenCalled();
  });
});
