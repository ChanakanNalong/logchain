import { ConfigService } from '@nestjs/config';
import { DetectionService, BatchLogInput } from './detection.service';

function makeService(url = 'http://detection-api:8000', timeout = '4000') {
  const config = {
    get: (key: string, def?: string) =>
      key === 'DETECTION_URL'
        ? url
        : key === 'DETECTION_TIMEOUT_MS'
          ? timeout
          : def,
  } as unknown as ConfigService;
  return new DetectionService(config);
}

/** fetch mock ที่คืน body เป็น JSON — cast เป็น typeof fetch (ไม่ใช่ any) */
function respondWith(body: unknown, ok = true, status = 200): typeof fetch {
  return jest.fn(() =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) }),
  ) as unknown as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return jest.fn(() => Promise.reject(new Error(message)));
}

const LOGS: BatchLogInput[] = [
  {
    eventType: 'AUTH_FAILURE',
    severity: 'WARNING',
    sourceIp: '203.0.113.1',
    source: 'host-a',
    cdeScope: false,
    createdAt: '2026-09-29T10:00:00.000Z',
  },
];

describe('DetectionService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('returns null when DETECTION_URL is empty (feature off)', async () => {
    const spy = jest.fn();
    global.fetch = spy;
    expect(await makeService('').scoreBatch('b1', LOGS)).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // ไม่ยิงเลย
  });

  it('returns null for an empty batch without calling detection', async () => {
    const spy = jest.fn();
    global.fetch = spy;
    expect(await makeService().scoreBatch('b1', [])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('parses an anomalous result', async () => {
    global.fetch = respondWith({
      is_anomaly: true,
      score: -0.12,
      model_available: true,
      reason: 'batch ผิดปกติ',
    });
    const out = await makeService().scoreBatch('b1', LOGS);
    expect(out).toEqual({
      isAnomaly: true,
      score: -0.12,
      reason: 'batch ผิดปกติ',
    });
  });

  it('parses a normal result', async () => {
    global.fetch = respondWith({
      is_anomaly: false,
      score: 0.2,
      model_available: true,
      reason: 'ปกติ',
    });
    const out = await makeService().scoreBatch('b1', LOGS);
    expect(out).toEqual({ isAnomaly: false, score: 0.2, reason: 'ปกติ' });
  });

  it('returns null when the model is not trained yet (model_available=false)', async () => {
    global.fetch = respondWith({
      is_anomaly: false,
      score: 0,
      model_available: false,
      reason: 'x',
    });
    expect(await makeService().scoreBatch('b1', LOGS)).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    global.fetch = respondWith({}, false, 503);
    expect(await makeService().scoreBatch('b1', LOGS)).toBeNull();
  });

  it('returns null when fetch throws (detection down)', async () => {
    global.fetch = throwingFetch('ECONNREFUSED');
    expect(await makeService().scoreBatch('b1', LOGS)).toBeNull();
  });

  it('never rejects — a thrown error becomes null, not an exception', async () => {
    global.fetch = throwingFetch('boom');
    await expect(makeService().scoreBatch('b1', LOGS)).resolves.toBeNull();
  });
});
