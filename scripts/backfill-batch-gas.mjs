#!/usr/bin/env node
/**
 * เติม batches.gas_used / effective_gas_price ย้อนหลังจาก receipt ของ tx_hash (eth_getTransactionReceipt)
 *
 * แตะแค่ 2 คอลัมน์นี้ และเฉพาะแถวที่ยังเป็น NULL — ห้ามแตะ root / status / mapping
 * ข้าม receipt ที่ status ≠ 1 หรือ `to` ไม่ใช่ CONTRACT_ADDRESS (tx คนละตัว — ไม่เดา)
 *
 * ใช้:  node scripts/backfill-batch-gas.mjs                 ← dry-run (ค่าเริ่มต้น) อ่านอย่างเดียว
 *       node scripts/backfill-batch-gas.mjs --apply         ← เขียนจริง
 *       ENV_FILE=.env.hardhat node scripts/backfill-batch-gas.mjs --apply   ← environment hh
 * env file: POSTGRES_PASSWORD · DB_HOST (localhost) · DB_PORT (5433) · BLOCKCHAIN_RPC_URL · CONTRACT_ADDRESS
 * dry-run รันใน transaction READ ONLY · ยังไม่ได้รัน migration BatchGasAndIndexes ก็ dry-run ได้ (--apply ไม่ได้)
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.ENV_FILE
  ? resolve(process.env.ENV_FILE)
  : join(__dirname, '..', '.env');
const APPLY = process.argv.includes('--apply');
const CONCURRENCY = 4;

function readEnv(path) {
  const map = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) map[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return map;
}

const env = { ...readEnv(ENV_PATH), ...process.env };
const rpcUrl = env.BLOCKCHAIN_RPC_URL;
if (!rpcUrl) throw new Error(`BLOCKCHAIN_RPC_URL missing in ${ENV_PATH}`);
const contract = (env.CONTRACT_ADDRESS || '').toLowerCase();

const db = new pg.Client({
  host: env.DB_HOST || 'localhost',
  port: Number(env.DB_PORT || 5433),
  user: 'logchain',
  database: 'logchain',
  password: env.POSTGRES_PASSWORD,
});

const pol = (wei) => ethers.formatEther(wei);
const gwei = (wei) => ethers.formatUnits(wei, 'gwei');

async function main() {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const { chainId } = await provider.getNetwork();
  await db.connect();
  console.log(`mode     : ${APPLY ? 'APPLY (writes gas_used / effective_gas_price)' : 'dry-run (read only)'}`);
  console.log(`env file : ${ENV_PATH}`);
  console.log(`db       : ${db.host}:${db.port}/logchain`);
  console.log(`rpc      : ${rpcUrl} (chainId ${chainId})`);
  console.log(`contract : ${contract || '(not set — `to` not checked)'}`);

  await db.query(APPLY ? 'BEGIN' : 'BEGIN READ ONLY');
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'batches' AND column_name IN ('gas_used', 'effective_gas_price')`,
  );
  const hasCols = cols.rows.length === 2;
  if (!hasCols && APPLY) {
    throw new Error('columns gas_used / effective_gas_price missing — run the backend once (migration BatchGasAndIndexes) first');
  }
  const rows = (
    await db.query(
      `SELECT id, status, tx_hash ${hasCols ? ', gas_used' : ', NULL AS gas_used'}
         FROM batches WHERE tx_hash IS NOT NULL ORDER BY sealed_at`,
    )
  ).rows;
  console.log(`columns  : ${hasCols ? 'present' : 'MISSING (migration not run yet) — dry-run only'}`);
  console.log(`batches with tx_hash: ${rows.length}\n`);

  const results = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < rows.length) {
        const i = next++;
        const r = rows[i];
        try {
          const rc = await provider.getTransactionReceipt(r.tx_hash);
          results[i] = { row: r, rc };
        } catch (err) {
          results[i] = { row: r, error: err.shortMessage ?? err.message };
        }
      }
    }),
  );

  let totalGas = 0n;
  let totalWei = 0n;
  let ok = 0;
  let wouldUpdate = 0;
  let updated = 0;
  const gases = [];
  const skipped = [];
  console.log('batch     status      tx          gasUsed   gwei        cost POL');
  for (const { row, rc, error } of results) {
    const id8 = row.id.slice(0, 8);
    if (error) { skipped.push(`${id8} receipt error: ${error}`); continue; }
    if (!rc) { skipped.push(`${id8} no receipt from this RPC (tx dropped, other chain, or node without tx history — check RootStored with eth_getLogs)`); continue; }
    if (rc.status !== 1) { skipped.push(`${id8} tx reverted (status ${rc.status})`); continue; }
    if (contract && (rc.to || '').toLowerCase() !== contract) {
      skipped.push(`${id8} tx to ${rc.to} ≠ CONTRACT_ADDRESS`); continue;
    }
    const cost = rc.gasUsed * rc.gasPrice;
    ok++;
    totalGas += rc.gasUsed;
    totalWei += cost;
    gases.push(rc.gasUsed);
    console.log(
      `${id8}  ${row.status.padEnd(10)}  ${row.tx_hash.slice(0, 10)}  ${String(rc.gasUsed).padStart(8)}  ${gwei(rc.gasPrice).padEnd(10)}  ${pol(cost)}`,
    );
    if (row.gas_used !== null) continue; // มีค่าแล้ว ไม่ทับ
    wouldUpdate++;
    if (APPLY) {
      const res = await db.query(
        `UPDATE batches SET gas_used = $2, effective_gas_price = $3
          WHERE id = $1 AND gas_used IS NULL`,
        [row.id, rc.gasUsed.toString(), rc.gasPrice.toString()],
      );
      updated += res.rowCount;
    }
  }
  await db.query(APPLY ? 'COMMIT' : 'ROLLBACK');

  console.log('\nsummary');
  console.log(`  receipts ok      : ${ok}/${rows.length}`);
  if (ok) {
    const min = gases.reduce((a, b) => (b < a ? b : a));
    const max = gases.reduce((a, b) => (b > a ? b : a));
    console.log(`  gas per tx       : min ${min} · max ${max} · avg ${totalGas / BigInt(ok)}`);
    console.log(`  total gas        : ${totalGas}`);
    console.log(`  total cost       : ${pol(totalWei)} POL (avg ${pol(totalWei / BigInt(ok))} POL/tx)`);
  }
  console.log(`  ${APPLY ? 'updated' : 'would update'}     : ${APPLY ? updated : wouldUpdate} row(s)${hasCols ? '' : ' (after migration)'}`);
  for (const s of skipped) console.log(`  skipped          : ${s}`);
  await db.end();
}

main().catch(async (err) => {
  console.error('backfill failed:', err.message ?? err);
  try { await db.query('ROLLBACK'); await db.end(); } catch { /* ignore */ }
  process.exit(1);
});
