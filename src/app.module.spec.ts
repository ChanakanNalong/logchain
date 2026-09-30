// jwks-rsa → jose เป็น ESM ที่ jest (ts-jest/CJS) โหลดไม่ได้ — เทสต์นี้อ่านแค่ metadata ไม่ใช้ JWT
jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn() }));

import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from './app.module';
import { HealthController } from './health/health.controller';
import { LogsController } from './logs/logs.controller';

// ThrottlerModule + @Throttle อย่างเดียวไม่มีผล ต้องมี ThrottlerGuard ลงทะเบียนด้วย
// เคยหลุดมาแล้ว (worklog 2026-09-29 หัวข้อ 3) — เทสต์นี้กันไม่ให้หายเงียบอีก
describe('rate limiting wiring', () => {
  it('registers ThrottlerGuard as a global guard', () => {
    const providers = Reflect.getMetadata('providers', AppModule) as unknown[];
    expect(providers).toContainEqual({
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    });
  });

  it('skips throttling on /health (docker healthcheck)', () => {
    expect(
      Reflect.getMetadata('THROTTLER:SKIP' + 'default', HealthController),
    ).toBe(true);
  });

  it('keeps the higher ingest limit on POST /logs', () => {
    const create = Object.getOwnPropertyDescriptor(
      LogsController.prototype,
      'create',
    )!.value as object;
    expect(Reflect.getMetadata('THROTTLER:LIMIT' + 'default', create)).toBe(
      500,
    );
  });
});
