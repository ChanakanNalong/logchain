// Demo (READ-ONLY): LogIntegrity ป้องกันการแก้ root ยังไง — พิสูจน์ด้วย eth_call
// ทั้งหมดเป็น eth_call = จำลองบน node, ไม่ broadcast tx, ไม่เสีย POL, ไม่แตะ state/DB
// owner อ่านจาก owner() ของสัญญา (ไม่ใช้ wallet/คีย์จาก env)
//   run: node scripts/demo-contract-guards.mjs
//
// CONTRACT/RPC: ต้องตรงกับที่ backend ใช้ anchor จริง ไม่งั้น getRoot=0 (เคส root ซ้ำจะไม่ revert = ผลผิด)
// ลำดับ: env (CONTRACT_ADDRESS/BLOCKCHAIN_RPC_URL) → อ่านจาก container logchain-backend → fallback ค่าในเล่ม
import { ethers } from "ethers";
import { execSync } from "node:child_process";

const fromBackend = (k) => {
  try {
    return execSync(`docker exec logchain-backend printenv ${k}`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || null;
  } catch {
    return null;
  }
};
const RPC =
  process.env.BLOCKCHAIN_RPC_URL ||
  fromBackend("BLOCKCHAIN_RPC_URL") ||
  "https://polygon-amoy-bor-rpc.publicnode.com";
const CONTRACT = ethers.getAddress(
  process.env.CONTRACT_ADDRESS ||
    fromBackend("CONTRACT_ADDRESS") ||
    "0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5",
);
const NOT_OWNER = ethers.getAddress("0x000000000000000000000000000000000000dEaD"); // address อื่น
const ABI = [
  "function owner() view returns (address)",
  "function storeRoot(bytes32 batch, bytes32 root) external",
  "function getRoot(bytes32 batch) view returns (bytes32 root, uint256 timestamp)",
];
const reason = (e) =>
  e?.reason ?? e?.revert?.args?.[0] ?? e?.shortMessage ?? e?.code ?? e?.message;
// SELECT อย่างเดียว — batch CONFIRMED ล่าสุดจาก DB local
const q = `SELECT id||' '||merkle_root FROM batches WHERE status='CONFIRMED'
  AND merkle_root IS NOT NULL ORDER BY sealed_at DESC NULLS LAST LIMIT 1`;

const main = async () => {
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(CONTRACT, ABI, provider);
  const owner = ethers.getAddress(await c.owner());

  const [id, root] = execSync(
    `docker exec logchain-postgres psql -U logchain -d logchain -tAc "${q}"`,
  ).toString().trim().split(/\s+/);
  const key = ethers.id(id); // batchId -> bytes32 (= backend)
  const [onchain] = await c.getRoot(key);
  const rootHex = "0x" + root;

  console.log("contract :", CONTRACT, "(Polygon Amoy)");
  console.log("rpc      :", RPC);
  console.log("owner()  :", owner);
  console.log("batch    :", id, "(CONFIRMED)");
  console.log("getRoot บนเชน == merkle_root ใน DB :",
    onchain.toLowerCase() === rootHex.toLowerCase() ? "ตรง ✓" : "ไม่ตรง ✗");

  console.log("\n#1 storeRoot จาก NON-OWNER (batch ใหม่) :", NOT_OWNER);
  try { await c.storeRoot.staticCall(ethers.id("new-" + Date.now()), rootHex, { from: NOT_OWNER });
        console.log("   ไม่ revert (ผิดคาด)"); }
  catch (e) { console.log("   REVERT →", reason(e)); }

  console.log("#2 storeRoot จาก OWNER ส่ง root ซ้ำของ batch เดิม :", owner);
  try { await c.storeRoot.staticCall(key, rootHex, { from: owner });
        console.log("   ไม่ revert (ผิดคาด)"); }
  catch (e) { console.log("   REVERT →", reason(e)); }

  console.log("\n(eth_call ล้วน — ไม่มี tx จริง ไม่เสีย POL)");
};
main().catch((e) => { console.error("error:", e.shortMessage || e.message); process.exit(1); });
