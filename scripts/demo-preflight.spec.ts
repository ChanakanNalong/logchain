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

/** รัน demo-preflight.sh โดยให้ psql คืน batchRows ตามที่กำหนด */
function runPreflight(batchRows: string): Run {
  const work = mkdtempSync(join(tmpdir(), 'preflight-'));
  const stub = join(work, 'bin');
  mkdirSync(stub);

  // .env ปลอมใน cwd — สคริปต์อ่าน BLOCKCHAIN_RPC_URL จาก ./.env
  writeFileSync(join(work, '.env'), 'BLOCKCHAIN_RPC_URL=http://rpc.test\n');

  // `docker compose ps` -> healthy, `docker exec ... psql` -> batchRows
  bin(
    stub,
    'docker',
    `#!/usr/bin/env bash\n` +
      `if [ "$1" = "exec" ]; then cat <<'ROWS'\n${batchRows}\nROWS\n` +
      `else echo "Up (healthy)"; fi\nexit 0\n`,
  );
  bin(stub, 'curl', '#!/usr/bin/env bash\nexit 0\n');
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
