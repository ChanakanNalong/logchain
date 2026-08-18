import { readFileSync } from 'fs';
import { ConfigService } from '@nestjs/config';
import { KafkaConfig } from 'kafkajs';

/**
 * สร้าง ssl option ให้ kafkajs จาก env (mTLS กับ SSL listener :39092-39094)
 *
 * KAFKA_SSL_ENABLED=false (default) -> คืน {} = ไม่มี key `ssl` เลย
 * kafkajs จะต่อแบบ plaintext เหมือนเดิมเป๊ะ (e2e/CI ยังใช้ได้)
 *
 * KAFKA_SSL_ENABLED=true -> อ่าน PEM จาก path ใน env
 *   KAFKA_SSL_CA   -> infra/kafka/certs/ca.crt        (verify ตัว broker)
 *   KAFKA_SSL_CERT -> certs/clients/nestjs.crt        (client cert ให้ broker verify เรา)
 *   KAFKA_SSL_KEY  -> certs/clients/nestjs.key
 */
export function buildKafkaSsl(cfg: ConfigService): Pick<KafkaConfig, 'ssl'> {
  const enabled = cfg.get<string>('KAFKA_SSL_ENABLED', 'false');
  if (enabled !== 'true' && enabled !== '1') return {};

  const caPath = cfg.get<string>('KAFKA_SSL_CA');
  const certPath = cfg.get<string>('KAFKA_SSL_CERT');
  const keyPath = cfg.get<string>('KAFKA_SSL_KEY');

  // เปิด SSL แล้วแต่ path ไม่ครบ = misconfig — fail ตอน boot ดีกว่าไป fallback
  // เป็น plaintext เงียบ ๆ แล้วนึกว่า log วิ่งผ่าน mTLS อยู่
  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      'KAFKA_SSL_ENABLED=true but KAFKA_SSL_CA / KAFKA_SSL_CERT / KAFKA_SSL_KEY is missing',
    );
  }

  return {
    ssl: {
      ca: [readFileSync(caPath, 'utf-8')],
      cert: readFileSync(certPath, 'utf-8'),
      key: readFileSync(keyPath, 'utf-8'),
    },
  };
}
