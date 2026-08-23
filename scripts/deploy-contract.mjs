#!/usr/bin/env node
/**
 * Deploy LogIntegrity ลง Hardhat local node แล้วเขียน CONTRACT_ADDRESS กลับเข้า .env อัตโนมัติ
 *
 * เหตุผล: Hardhat node เป็น in-memory ทุกครั้งที่ restart ต้อง deploy ใหม่
 * และ address เปลี่ยนตาม nonce ของ deployer — script นี้ลด manual step
 * (deploy + แก้ .env เอง) ให้เหลือคำสั่งเดียว
 *
 * ใช้:  node scripts/deploy-contract.mjs
 *       (อ่าน RPC/private key จาก .env, ไม่ต้องส่ง argument)
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const ARTIFACT_PATH =
  process.env.CONTRACT_ARTIFACT ??
  join(
    process.env.HOME,
    'Documents/logchain-contracts/artifacts/contracts/LogIntegrity.sol/LogIntegrity.json',
  );

// --- helper: parse .env เป็น key=value (เก็บบรรทัด comment/ว่างไว้ด้วย) ---
function readEnv(path) {
  const raw = readFileSync(path, 'utf8');
  const map = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return { raw, map };
}

// --- helper: เขียน/แทนที่ค่า key ใน .env โดยไม่แตะบรรทัดอื่น ---
function upsertEnv(raw, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(raw)) return raw.replace(re, line);
  return raw.replace(/\n*$/, '\n') + line + '\n';
}

async function main() {
  const { raw, map } = readEnv(ENV_PATH);
  const rpcUrl = map.BLOCKCHAIN_RPC_URL;
  if (!rpcUrl)
    throw new Error(
      'BLOCKCHAIN_RPC_URL ไม่มีใน .env — ต้องตั้งก่อน deploy (เช่น https://polygon-amoy-bor-rpc.publicnode.com)',
    );
  const pk = map.BLOCKCHAIN_PRIVATE_KEY;
  if (!pk) throw new Error('BLOCKCHAIN_PRIVATE_KEY ไม่มีใน .env');

  const art = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(pk, provider);
  console.log(`Deploying LogIntegrity to ${rpcUrl} as ${wallet.address} ...`);

  const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  const updated = upsertEnv(raw, 'CONTRACT_ADDRESS', address);
  writeFileSync(ENV_PATH, updated);

  console.log(`LogIntegrity deployed at: ${address}`);
  console.log(`Wrote CONTRACT_ADDRESS=${address} -> ${ENV_PATH}`);
}

main().catch((err) => {
  console.error('Deploy failed:', err.message ?? err);
  process.exit(1);
});
