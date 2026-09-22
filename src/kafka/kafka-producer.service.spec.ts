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
    return new KafkaProducerService(cfg);
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

  it('ระหว่างยังต่อไม่ติด ข้าม publish และเตือนครั้งเดียว', async () => {
    mockProducer.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const svc = fastService();
    svc.onModuleInit();
    await svc.publishLog(event);
    await svc.publishLog(event);

    expect(mockProducer.send).not.toHaveBeenCalled();
    const skipped = warn.mock.calls.filter(([m]) =>
      String(m).includes('ไม่ถูกส่งไป detection'),
    );
    expect(skipped).toHaveLength(1);
    await svc.onModuleDestroy();
  });

  it('shutdown ระหว่างรอ backoff ไม่ค้าง และไม่ disconnect ถ้ายังไม่เคยต่อติด', async () => {
    mockProducer.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    const cfg = {
      get: (key: string, def?: unknown) =>
        key === 'KAFKA_RECONNECT_BASE_MS' ? 60000 : (def ?? ''),
    } as unknown as ConfigService;
    const svc = new KafkaProducerService(cfg);
    svc.onModuleInit();
    await until(() => mockProducer.connect.mock.calls.length === 1);

    const started = Date.now();
    await svc.onModuleDestroy();

    expect(Date.now() - started).toBeLessThan(1000);
    expect(mockProducer.disconnect).not.toHaveBeenCalled();
  });
});
