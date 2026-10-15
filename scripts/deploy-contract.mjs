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
 *       ENV_FILE=.env.hardhat node scripts/deploy-contract.mjs   ← environment hh
 *
 * ก่อน deploy พิมพ์ RPC + chainId + signer เสมอ · chainId ≠ 31337 (Hardhat) = chain จริง
 * เสีย gas จริง → ต้องตั้ง CONFIRM_REAL_CHAIN=1 ถึงจะยอม (กัน deploy ขึ้น Amoy โดยไม่ตั้งใจ
 * เพราะ .env ของ stack หลักชี้ Amoy อยู่)
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = process.env.ENV_FILE
  ? resolve(process.env.ENV_FILE)
  : join(__dirname, '..', '.env');
const HARDHAT_CHAIN_ID = 31337n;
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
  const { chainId } = await provider.getNetwork();
  console.log(`env file : ${ENV_PATH}`);
  console.log(`RPC      : ${rpcUrl}`);
  console.log(`chainId  : ${chainId}`);
  console.log(`signer   : ${wallet.address}`);
  if (chainId !== HARDHAT_CHAIN_ID && process.env.CONFIRM_REAL_CHAIN !== '1') {
    throw new Error(
      `chainId ${chainId} is not Hardhat (${HARDHAT_CHAIN_ID}) — deploying costs real gas. ` +
        'Re-run with CONFIRM_REAL_CHAIN=1 if that is intended',
    );
  }
  console.log(`Deploying LogIntegrity ...`);

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
