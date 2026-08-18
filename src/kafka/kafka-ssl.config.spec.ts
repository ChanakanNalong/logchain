import { ConfigService } from '@nestjs/config';
import { buildKafkaSsl } from './kafka-ssl.config';

/** ConfigService จำลอง — คืนค่าจาก map, ไม่มีก็ใช้ default ที่ caller ส่งมา */
function cfgOf(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

const CA = 'infra/kafka/certs/ca.crt';
const CERT = 'infra/kafka/certs/clients/nestjs.crt';
const KEY = 'infra/kafka/certs/clients/nestjs.key';

describe('buildKafkaSsl', () => {
  it('ไม่ใส่ key ssl เลยเมื่อ toggle ไม่ได้ตั้ง (default plaintext)', () => {
    expect(buildKafkaSsl(cfgOf({}))).toEqual({});
  });

  it('ไม่ใส่ key ssl เมื่อ KAFKA_SSL_ENABLED=false', () => {
    const out = buildKafkaSsl(cfgOf({ KAFKA_SSL_ENABLED: 'false' }));
    expect(out).toEqual({});
    expect('ssl' in out).toBe(false);
  });

  it('อ่าน PEM ทั้งสามไฟล์เมื่อ KAFKA_SSL_ENABLED=true', () => {
    const out = buildKafkaSsl(
      cfgOf({
        KAFKA_SSL_ENABLED: 'true',
        KAFKA_SSL_CA: CA,
        KAFKA_SSL_CERT: CERT,
        KAFKA_SSL_KEY: KEY,
      }),
    );
    const ssl = out.ssl as { ca: string[]; cert: string; key: string };
    expect(ssl.ca[0]).toContain('BEGIN CERTIFICATE');
    expect(ssl.cert).toContain('BEGIN CERTIFICATE');
    expect(ssl.key).toContain('PRIVATE KEY');
  });

  it('throw เมื่อเปิด SSL แต่ path ไม่ครบ — ไม่ fallback เป็น plaintext เงียบ ๆ', () => {
    expect(() =>
      buildKafkaSsl(cfgOf({ KAFKA_SSL_ENABLED: 'true', KAFKA_SSL_CA: CA })),
    ).toThrow(/KAFKA_SSL_CA \/ KAFKA_SSL_CERT \/ KAFKA_SSL_KEY/);
  });
});
