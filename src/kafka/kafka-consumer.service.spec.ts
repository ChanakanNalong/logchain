import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';

const mockConsumer = {
  connect: jest.fn(),
  subscribe: jest.fn(),
  run: jest.fn(),
  disconnect: jest.fn(),
  on: jest.fn(),
  events: {
    CRASH: 'consumer.crash',
    GROUP_JOIN: 'consumer.group_join',
    DISCONNECT: 'consumer.disconnect',
  },
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: () => mockConsumer,
  })),
  CompressionTypes: { GZIP: 1 },
}));

// ต้อง import หลัง jest.mock
import { KafkaConsumerService } from './kafka-consumer.service';
import { AlertsService } from '../alerts/alerts.service';

/**
 * บั๊กที่เทสนี้คุม: ของเดิม retry connect 5 ครั้งแล้ว log
 * "Kafka consumer unavailable — alert persistence disabled" แล้วหยุดถาวร
 * เจอจริงตอน `docker compose down -v` — broker boot นานกว่า ~30 วิที่ retry ครอบคลุม
 * backend ที่ค้างบน host จึงเลิกฟัง alert ไปเลยโดยไม่มีใครรู้
 */
describe('KafkaConsumerService — reconnect', () => {
  const alerts = { createOrDedup: jest.fn() } as unknown as AlertsService;

  /** backoff สั้น ๆ เพื่อให้เทสไม่ต้องรอจริง */
  function makeService(overrides: Record<string, unknown> = {}) {
    const cfg = {
      get: (key: string, def?: unknown) =>
        key in overrides ? overrides[key] : (def ?? ''),
    } as unknown as ConfigService;
    return new KafkaConsumerService(cfg, alerts);
  }

  function fastService() {
    return makeService({
      KAFKA_RECONNECT_BASE_MS: 1,
      KAFKA_RECONNECT_MAX_MS: 2,
      KAFKA_BROKERS: 'kafka-1:9092',
    });
  }

  /** รอจน predicate เป็นจริง (หรือ timeout) — loop เป็น async ไม่มี hook ให้ await */
  async function until(fn: () => boolean, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error('timeout รอเงื่อนไขไม่สำเร็จ');
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockConsumer.connect.mockResolvedValue(undefined);
    mockConsumer.subscribe.mockResolvedValue(undefined);
    mockConsumer.run.mockResolvedValue(undefined);
    mockConsumer.disconnect.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  it('เชื่อมต่อและ subscribe ทั้งสอง topic ตอน boot', async () => {
    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topics: ['alerts.raw', 'alerts.cde'],
      fromBeginning: false,
    });
    await svc.onModuleDestroy();
  });

  it('ไม่ยอมแพ้หลัง 5 ครั้ง — ต่อติดที่ครั้งที่ 12', async () => {
    let calls = 0;
    mockConsumer.connect.mockImplementation(async () => {
      calls++;
      if (calls < 12) throw new Error('ECONNREFUSED');
    });

    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    expect(calls).toBe(12);
    expect(svc.getHealth().connected).toBe(true);
    await svc.onModuleDestroy();
  });

  it('ไม่ log ข้อความ "alert persistence disabled" ของเดิมอีกแล้ว', async () => {
    let calls = 0;
    mockConsumer.connect.mockImplementation(async () => {
      calls++;
      if (calls < 8) throw new Error('ECONNREFUSED');
    });

    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const errors = (Logger.prototype.error as jest.Mock).mock.calls
      .flat()
      .join(' ');
    const warns = (Logger.prototype.warn as jest.Mock).mock.calls
      .flat()
      .join(' ');
    expect(`${errors} ${warns}`).not.toContain('alert persistence disabled');
    await svc.onModuleDestroy();
  });

  it('log ทุกครั้งที่ retry เพื่อให้เห็นว่ายังพยายามอยู่', async () => {
    let calls = 0;
    mockConsumer.connect.mockImplementation(async () => {
      calls++;
      if (calls < 6) throw new Error('ECONNREFUSED');
    });

    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const warns = (Logger.prototype.warn as jest.Mock).mock.calls.map((c) =>
      String(c[0]),
    );
    const retryLogs = warns.filter((m) => m.includes('connect failed'));
    expect(retryLogs).toHaveLength(5); // ล้มเหลว 5 ครั้งแรก ต้องมี log ครบทุกครั้ง
    expect(retryLogs[0]).toContain('attempt 1');
    expect(retryLogs[4]).toContain('attempt 5');
    expect(retryLogs[0]).toContain('ECONNREFUSED');
    await svc.onModuleDestroy();
  });

  it('backoff โตแบบ exponential แล้วตันที่ 60 วิ', () => {
    const svc = makeService(); // ใช้ default 1000ms / 60000ms
    const backoff = (n: number) => (svc as any).backoffMs(n) as number;

    expect([1, 2, 3, 4, 5, 6].map(backoff)).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000,
    ]);
    // ครั้งที่ 7 เป็นต้นไปต้องไม่เกิน cap
    expect(backoff(7)).toBe(60000);
    expect(backoff(50)).toBe(60000);
  });

  it('health บอก connected=false พร้อม error ระหว่างที่ยังต่อไม่ได้', async () => {
    mockConsumer.connect.mockRejectedValue(new Error('broker ล่ม'));

    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().reconnectAttempts >= 3);

    const health = svc.getHealth();
    expect(health.connected).toBe(false);
    expect(health.lastError).toBe('broker ล่ม');
    expect(health.lastConnectedAt).toBeNull();
    await svc.onModuleDestroy();
  });

  it('health บอก connected=true + เวลาที่ต่อติด หลังเชื่อมต่อสำเร็จ', async () => {
    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const health = svc.getHealth();
    expect(health.connected).toBe(true);
    expect(health.lastError).toBeNull();
    expect(Date.parse(health.lastConnectedAt as string)).not.toBeNaN();
    await svc.onModuleDestroy();
  });

  it('หยุด retry ตอน shutdown ไม่วนต่อไม่รู้จบ', async () => {
    mockConsumer.connect.mockRejectedValue(new Error('ECONNREFUSED'));

    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().reconnectAttempts >= 2);

    await svc.onModuleDestroy();
    const after = mockConsumer.connect.mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(mockConsumer.connect.mock.calls.length).toBe(after);
  });

  it('เชื่อมต่อใหม่เมื่อ consumer crash แบบที่ kafkajs ไม่ restart ให้', async () => {
    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const crashHandler = mockConsumer.on.mock.calls.find(
      (c) => c[0] === 'consumer.crash',
    )?.[1] as (e: unknown) => void;
    expect(crashHandler).toBeDefined();

    const before = mockConsumer.connect.mock.calls.length;
    crashHandler({
      payload: { error: new Error('rebalance ล้ม'), restart: false },
    });

    expect(svc.getHealth().connected).toBe(false);
    await until(() => mockConsumer.connect.mock.calls.length > before);
    await until(() => svc.getHealth().connected);
    await svc.onModuleDestroy();
  });

  it('ปล่อยให้ kafkajs จัดการเองถ้า crash แบบ restart=true', async () => {
    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const crashHandler = mockConsumer.on.mock.calls.find(
      (c) => c[0] === 'consumer.crash',
    )?.[1] as (e: unknown) => void;

    const before = mockConsumer.connect.mock.calls.length;
    crashHandler({ payload: { error: new Error('ชั่วคราว'), restart: true } });
    await new Promise((r) => setTimeout(r, 20));

    expect(mockConsumer.connect.mock.calls.length).toBe(before);
    await svc.onModuleDestroy();
  });

  it('กลับมา connected เมื่อ kafkajs restart ให้เองแล้วเข้ากลุ่มได้ (/health ต้องไม่โกหก)', async () => {
    const svc = fastService();
    svc.onModuleInit();
    await until(() => svc.getHealth().connected);

    const handler = (name: string) =>
      mockConsumer.on.mock.calls.find((c) => c[0] === name)?.[1] as (
        e?: unknown,
      ) => void;

    // broker หาย -> kafkajs บอกว่าจะ restart ให้เอง
    handler('consumer.crash')({
      payload: { error: new Error('No broker available'), restart: true },
    });
    expect(svc.getHealth().connected).toBe(false);
    expect(svc.getHealth().reconnectAttempts).toBe(1); // ต้องเห็นว่ากำลังพยายามอยู่

    // kafkajs ต่อกลับได้เอง แล้วเข้ากลุ่มสำเร็จ
    handler('consumer.group_join')({});
    const health = svc.getHealth();
    expect(health.connected).toBe(true);
    expect(health.lastError).toBeNull();
    expect(health.reconnectAttempts).toBe(0);
    await svc.onModuleDestroy();
  });
});
