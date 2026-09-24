import { createServer, Server } from 'http';
import { Logger } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape แยก port จาก API (review B5)
 *
 * เดิม GET /metrics อยู่บน :3000 ตัวเดียวกับ API ซึ่ง publish ออก host โดยไม่มี auth — เปิดเผยจำนวน batch
 * ตามสถานะ / อายุ batch ค้าง ฯลฯ และถ้าตั้ง PUBLISH_ADDR=0.0.0.0 ก็เห็นกันทั้ง LAN
 * port นี้ไม่ publish ใน compose → เข้าถึงได้เฉพาะใน docker network (Prometheus) แบบเดียวกับ
 * detection-consumer :9101 · ไม่ต้องมี token ให้ Prometheus ถือ
 */
export function startMetricsServer(
  metrics: MetricsService,
  port = Number(process.env.METRICS_PORT ?? 9464),
): Server {
  const logger = new Logger('MetricsServer');
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url?.split('?')[0] !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    metrics
      .getMetrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': metrics.getContentType() });
        res.end(body);
      })
      .catch((err: Error) => {
        logger.error(`scrape failed: ${err.message}`);
        res.writeHead(500).end();
      });
  });
  server.listen(port, () =>
    logger.log(`Prometheus metrics on :${port}/metrics`),
  );
  return server;
}
