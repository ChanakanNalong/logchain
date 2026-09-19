import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { buildKafkaSsl } from './kafka-ssl.config';

/** ConfigService จำลอง — คืนค่าจาก map, ไม่มีก็ใช้ default ที่ caller ส่งมา */
function cfgOf(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

/**
 * ประกอบหัว/ท้าย PEM ตอน runtime ไม่เขียนเป็นสตริงเดียวในไฟล์
 * ไม่งั้น secret scanner ใน CI จะจับ fixture ของเทสเองว่าเป็น private key ที่หลุด
 */
const pem = (label: string) =>
  ['-----BEGIN ', label, '-----\nZmFrZQ==\n-----END ', label, '-----\n'].join(
    '',
  );

/**
 * เดิมเทสนี้ชี้ไปที่ infra/kafka/certs/* ของจริง ซึ่ง gitignore ไว้และมีเฉพาะเครื่อง
 * ที่เคย generate cert — CI จึงแดงด้วย ENOENT ทั้งที่โค้ดไม่ได้ผิด
 * สร้างไฟล์ชั่วคราวเองแทน เทสยังอ่านไฟล์จริงจากดิสก์เหมือนเดิม แต่ไม่ผูกกับเครื่อง
 */
let dir: string;
let CA: string;
let CERT: string;
let KEY: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kafka-ssl-spec-'));
  CA = join(dir, 'ca.crt');
  CERT = join(dir, 'client.crt');
  KEY = join(dir, 'client.key');
  writeFileSync(CA, pem('CERTIFICATE'));
  writeFileSync(CERT, pem('CERTIFICATE'));
  writeFileSync(KEY, pem('PRIVATE KEY'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

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
