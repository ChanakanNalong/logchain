import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * demo-preflight.sh เคยสรุปผลว่า "🎉 พร้อม demo" ทั้งที่มี ❌ เพราะบล็อกเช็ค batch
 * เขียนเป็น `psql ... | while read` — pipeline ทำให้ while รันใน subshell
 * FAIL=1 ที่ bad() ตั้งจึงตายไปพร้อม subshell (เจอจริงตอน batch เป็น PENDING:1)
 *
 * เทสนี้รันสคริปต์จริงโดยวาง stub ของ docker/curl/pgrep ไว้หน้า PATH
 * เพื่อคุมผลลัพธ์ของ psql ได้ — ไม่ต้องมี stack รันอยู่
 */

const SCRIPT = resolve(__dirname, 'demo-preflight.sh');

/** เขียนไฟล์ executable */
function bin(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

type Run = { stdout: string; code: number };

/** topic ครบตามที่ demo ต้องใช้ — ค่า default ของ runPreflight */
const ALL_TOPICS = [
  'logs.raw',
  'logs.raw.dlq',
  'alerts.raw',
  'alerts.cde',
].join('\n');

/** ค่า default ของ GET /health — consumer ต่อ Kafka ติดอยู่ */
const HEALTH_OK =
  '{"status":"ok","kafkaConsumer":{"connected":true,"lastError":null}}';

/** รัน demo-preflight.sh โดยคุมผลของ psql / kafka-topics.sh / GET /health */
function runPreflight(
  batchRows: string,
  topics: string = ALL_TOPICS,
  health: string = HEALTH_OK,
): Run {
  const work = mkdtempSync(join(tmpdir(), 'preflight-'));
  const stub = join(work, 'bin');
  mkdirSync(stub);

  // .env ปลอมใน cwd — สคริปต์อ่าน BLOCKCHAIN_RPC_URL จาก ./.env
  writeFileSync(join(work, '.env'), 'BLOCKCHAIN_RPC_URL=http://rpc.test\n');

  // `docker compose ps` -> healthy
  // `docker exec ... kafka-topics.sh --list` -> topics
  // `docker exec ... psql` -> batchRows
  bin(
    stub,
    'docker',
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "exec" ]; then\n` +
      `  case "$*" in\n` +
      `    *kafka-topics.sh*) cat <<'TOPICS'\n${topics}\nTOPICS\n    ;;\n` +
      `    *) cat <<'ROWS'\n${batchRows}\nROWS\n    ;;\n` +
      `  esac\n` +
      `else echo "Up (healthy)"; fi\nexit 0\n`,
  );
  // curl ถูกใช้ 3 ที่: /health, frontend :3003, RPC — มีแต่ /health ที่ต้องคืนเนื้อ
  bin(
    stub,
    'curl',
    `#!/usr/bin/env bash\n` +
      `case "$*" in\n` +
      `  *localhost:3000/health*) cat <<'HEALTH'\n${health}\nHEALTH\n  ;;\n` +
      `esac\nexit 0\n`,
  );
  bin(stub, 'pgrep', '#!/usr/bin/env bash\nexit 0\n');

  try {
    const stdout = execFileSync('bash', [SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}` },
    });
    return { stdout, code: 0 };
  } catch (err: any) {
    return { stdout: String(err.stdout ?? ''), code: err.status ?? -1 };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe('demo-preflight.sh — batch status gate', () => {
  it('reports ready when every batch is CONFIRMED', () => {
    const { stdout, code } = runPreflight('CONFIRMED:3');

    expect(stdout).toContain('✅ batches CONFIRMED:3');
    expect(stdout).toContain('🎉 พร้อม demo');
    expect(stdout).not.toContain('⛔');
    expect(code).toBe(0);
  });

  it('blocks on a PENDING batch — the exact case that used to print 🎉', () => {
    const { stdout, code } = runPreflight('CONFIRMED:3\nPENDING:1');

    expect(stdout).toContain('❌ batches PENDING:1');
    expect(stdout).toContain('⛔ ยังไม่พร้อม');
    expect(stdout).not.toContain('🎉 พร้อม demo');
    expect(code).toBe(1);
  });

  it.each(['FAILED:1', 'TAMPERED:1', 'UNVERIFIED:2'])(
    'blocks on a %s batch',
    (row) => {
      const { stdout, code } = runPreflight(`CONFIRMED:3\n${row}`);

      expect(stdout).toContain(`❌ batches ${row}`);
      expect(stdout).toContain('⛔ ยังไม่พร้อม');
      expect(code).toBe(1);
    },
  );

  it('blocks when a non-CONFIRMED row is the only batch', () => {
    const { stdout, code } = runPreflight('PENDING:1');

    expect(stdout).toContain('⛔ ยังไม่พร้อม');
    expect(code).toBe(1);
  });

  it('blocks when nothing has ever been sealed', () => {
    const { stdout, code } = runPreflight('');

    expect(stdout).toContain('❌ ไม่มี batch เลย');
    expect(stdout).toContain('⛔ ยังไม่พร้อม');
    expect(code).toBe(1);
  });
});

/**
 * เคสจริง: หลัง `docker compose down -v` แล้ว up ใหม่ alerts.raw/alerts.cde ไม่ถูกสร้าง
 * (มีแค่ logs.raw ที่ producer auto-create ให้) detection ยิง alert ได้ แต่ backend
 * ไม่มี topic ให้ subscribe → alert ไม่เข้า DB โดยไม่มี error ทั้งสองฝั่ง
 * kafka-init ใน docker-compose.yml สร้าง topic ให้แล้ว บล็อกนี้กันไม่ให้ regress เงียบ ๆ
 */
describe('demo-preflight.sh — kafka topic gate', () => {
  it('reports ready when every required topic exists', () => {
    const { stdout, code } = runPreflight('CONFIRMED:3');

    expect(stdout).toContain('✅ topic logs.raw');
    expect(stdout).toContain('✅ topic alerts.raw');
    expect(stdout).toContain('✅ topic alerts.cde');
    expect(stdout).toContain('🎉 พร้อม demo');
    expect(code).toBe(0);
  });

  it.each(['alerts.raw', 'alerts.cde', 'logs.raw'])(
    'blocks when %s is missing',
    (missing) => {
      const topics = ALL_TOPICS.split('\n')
        .filter((t) => t !== missing)
        .join('\n');
      const { stdout, code } = runPreflight('CONFIRMED:3', topics);

      expect(stdout).toContain(`❌ topic ${missing} หาย`);
      expect(stdout).toContain('⛔ ยังไม่พร้อม');
      expect(stdout).not.toContain('🎉 พร้อม demo');
      expect(code).toBe(1);
    },
  );

  it('blocks on the exact down -v case — only logs.raw auto-created', () => {
    const { stdout, code } = runPreflight('CONFIRMED:3', 'logs.raw');

    expect(stdout).toContain('✅ topic logs.raw');
    expect(stdout).toContain('❌ topic alerts.raw หาย');
    expect(stdout).toContain('❌ topic alerts.cde หาย');
    expect(code).toBe(1);
  });

  // logs.raw.dlq ไม่ได้อยู่ใน gate — ต้องไม่ทำให้ผลเปลี่ยนไม่ว่ามีหรือไม่มี
  it('ignores logs.raw.dlq', () => {
    const { stdout, code } = runPreflight(
      'CONFIRMED:3',
      'logs.raw\nalerts.raw\nalerts.cde',
    );

    expect(stdout).toContain('🎉 พร้อม demo');
    expect(code).toBe(0);
  });

  // grep -qx ต้อง match ทั้งบรรทัด ไม่ใช่ substring ไม่งั้น topic ชื่อคล้ายกันหลอกผ่านได้
  it('does not accept a prefix match as the real topic', () => {
    const { stdout, code } = runPreflight(
      'CONFIRMED:3',
      'logs.raw\nalerts.raw.v2\nalerts.cde',
    );

    expect(stdout).toContain('❌ topic alerts.raw หาย');
    expect(code).toBe(1);
  });
});

/**
 * KafkaConsumerService เคย retry 5 ครั้งแล้วยอมแพ้ถาวร (log "alert persistence disabled")
 * backend จึงยังตอบ /health เป็น 200 ทั้งที่ไม่ได้ฟัง alerts.raw/alerts.cde อยู่เลย
 * gate นี้จับเคสนั้น — ของเดิม preflight เห็นแค่ว่า :3000 ตอบก็ผ่านแล้ว
 */
describe('demo-preflight.sh — kafka consumer gate', () => {
  const healthWith = (connected: boolean, lastError: string | null = null) =>
    JSON.stringify({ status: 'ok', kafkaConsumer: { connected, lastError } });

  it('reports ready when the consumer is connected', () => {
    const { stdout, code } = runPreflight(
      'CONFIRMED:3',
      ALL_TOPICS,
      healthWith(true),
    );

    expect(stdout).toContain('✅ alert consumer เชื่อมต่อ Kafka อยู่');
    expect(stdout).toContain('🎉 พร้อม demo');
    expect(code).toBe(0);
  });

  it('blocks when the backend is up but not consuming alerts', () => {
    const { stdout, code } = runPreflight(
      'CONFIRMED:3',
      ALL_TOPICS,
      healthWith(false, 'ECONNREFUSED'),
    );

    expect(stdout).toContain('✅ backend :3000'); // process ยังอยู่ — เดิมผ่านแค่นี้
    expect(stdout).toContain('❌ alert consumer ไม่ได้ต่อ Kafka');
    expect(stdout).toContain('⛔ ยังไม่พร้อม');
    expect(code).toBe(1);
  });

  it('blocks when /health has no kafkaConsumer field at all', () => {
    const { stdout, code } = runPreflight(
      'CONFIRMED:3',
      ALL_TOPICS,
      '{"status":"ok"}',
    );

    expect(stdout).toContain('❌ อ่านสถานะ kafkaConsumer จาก /health ไม่ได้');
    expect(code).toBe(1);
  });
});
