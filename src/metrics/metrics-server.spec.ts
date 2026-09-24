import { AddressInfo } from 'net';
import { Server } from 'http';
import { startMetricsServer } from './metrics-server';
import { MetricsService } from './metrics.service';

describe('startMetricsServer', () => {
  let server: Server;
  let base: string;
  const metrics = {
    getMetrics: jest.fn(() => Promise.resolve('logchain_up 1\n')),
    getContentType: () => 'text/plain; version=0.0.4',
  } as unknown as MetricsService;

  beforeAll(async () => {
    server = startMetricsServer(metrics, 0); // 0 = port ว่างตัวไหนก็ได้
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('serves the registry at GET /metrics', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await res.text()).toBe('logchain_up 1\n');
  });

  it('404 for anything else — this port only exists for Prometheus', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/logs`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('500 (not a crash) when collecting metrics fails', async () => {
    (metrics.getMetrics as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    expect((await fetch(`${base}/metrics`)).status).toBe(500);
  });
});
