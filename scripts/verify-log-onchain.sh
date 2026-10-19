#!/usr/bin/env bash
# Verify one log end-to-end, read-only (no gas, no DB writes):
#   1) show the stored row
#   2) recompute raw_hash from the row fields (same canonical JSON as log-hash.ts)
#   3) rebuild the batch Merkle root from every log in the batch
#   4) read the root stored on Polygon Amoy (contract getRoot) and compare
# Usage: ./scripts/verify-log-onchain.sh [LOG_ID]   (default: newest log in a CONFIRMED batch)
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL(){ docker exec logchain-postgres psql -U logchain -d logchain -tAc "$1"; }

LOG_ID="${1:-$(PSQL "SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id=l.id
                     JOIN batches b ON b.id=m.batch_id WHERE b.status='CONFIRMED'
                     ORDER BY l.created_at DESC LIMIT 1")}"
[[ "$LOG_ID" =~ ^[0-9a-f-]{36}$ ]] || { echo "LOG_ID ต้องเป็น UUID เต็ม"; exit 1; }

# timestamps as ms-precision ISO strings (= JS Date.toISOString used at ingest)
ROW="json_build_object('id',l.id,'source',l.source,'sourceIp',host(l.source_id),
     'eventType',l.event_type,'severity',l.severity,'message',l.message,
     'classification',l.classification,'cdeScope',l.cde_scope,
     'createdAt',to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),
     'rawHash',l.raw_hash)"
JSON=$(PSQL "SELECT json_build_object(
  'log',(SELECT $ROW FROM logs l WHERE l.id='$LOG_ID'),
  'batch',(SELECT json_build_object('id',b.id,'status',b.status,'merkleRoot',b.merkle_root,
            'txHash',b.tx_hash,'blockNumber',b.block_number,'logCount',b.log_count)
           FROM batches b JOIN log_batch_mapping m ON m.batch_id=b.id WHERE m.log_id='$LOG_ID'),
  'leaves',(SELECT json_agg(l.raw_hash ORDER BY l.created_at, l.id) FROM logs l
            JOIN log_batch_mapping m ON m.log_id=l.id
            WHERE m.batch_id=(SELECT batch_id FROM log_batch_mapping WHERE log_id='$LOG_ID')))")

# node runs inside the backend container: it already has ethers, merkletreejs,
# BLOCKCHAIN_RPC_URL and CONTRACT_ADDRESS. The private key is never used (view call only).
printf '%s' "$JSON" | docker exec -i logchain-backend node -e '
const { createHash } = require("crypto");
const { MerkleTree } = require("merkletreejs");
const { ethers } = require("ethers");
const sha256 = (d) => createHash("sha256").update(d).digest();
const ok = (b) => (b ? "✅ ตรง" : "❌ ไม่ตรง");

(async () => {
  const { log, batch, leaves } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!log || !batch) { console.log("ไม่พบ log หรือ log ยังไม่ถูก seal เข้า batch"); process.exit(1); }

  console.log("═══ 1) log ที่เก็บใน DB ═══");
  for (const [k, v] of Object.entries(log)) console.log(`  ${k.padEnd(15)}${JSON.stringify(v)}`);

  console.log("\n═══ 2) hash ใหม่จาก field ข้างบน ═══");
  const canonical = JSON.stringify({ v: 2, id: log.id, source: log.source, sourceIp: log.sourceIp,
    eventType: log.eventType, severity: log.severity, message: log.message,
    classification: log.classification, cdeScope: log.cdeScope, createdAt: log.createdAt });
  const recomputed = createHash("sha256").update(canonical, "utf8").digest("hex");
  console.log("  canonical JSON :", canonical);
  console.log("  sha256 ใหม่    :", recomputed);
  console.log("  raw_hash ใน DB :", log.rawHash);
  console.log("  ผล             :", ok(recomputed === log.rawHash));

  console.log(`\n═══ 3) สร้าง Merkle root จาก ${leaves.length} log ใน batch ${batch.id} ═══`);
  const tree = new MerkleTree(leaves.map(sha256), sha256, { sortPairs: true });
  const root = tree.getHexRoot();
  const proof = tree.getProof(sha256(log.rawHash));
  console.log("  root ที่คำนวณ  :", root);
  console.log("  root ใน DB     :", "0x" + batch.merkleRoot.replace(/^0x/, ""));
  console.log("  proof (" + proof.length + " ขั้น) พิสูจน์ว่า log นี้อยู่ใน root:",
    ok(tree.verify(proof, sha256(log.rawHash), root)));

  console.log("\n═══ 4) root บน blockchain (Polygon Amoy) ═══");
  const provider = new ethers.JsonRpcProvider(process.env.BLOCKCHAIN_RPC_URL);
  const c = new ethers.Contract(process.env.CONTRACT_ADDRESS,
    ["function getRoot(bytes32 batch) view returns (bytes32 root, uint256 timestamp)"], provider);
  const [chainRoot, ts] = await c.getRoot(ethers.id(batch.id));
  console.log("  contract       :", process.env.CONTRACT_ADDRESS);
  console.log("  key (keccak256 ของ batch id):", ethers.id(batch.id));
  console.log("  root บน chain  :", chainRoot);
  console.log("  เวลาบน chain   :", new Date(Number(ts) * 1000).toISOString());
  console.log("  tx             :", batch.txHash, " block", batch.blockNumber);
  console.log("  explorer       : https://amoy.polygonscan.com/tx/" + batch.txHash);
  console.log("  ผล (คำนวณ vs chain):", ok(chainRoot.toLowerCase() === root.toLowerCase()));

  console.log("\n═══ 5) ถ้ามีคนแก้ severity เป็น LOW (คำนวณในหน่วยความจำ ไม่แตะ DB) ═══");
  const forged = createHash("sha256").update(canonical.replace(/"severity":"[^"]*"/, "\"severity\":\"LOW\""), "utf8").digest("hex");
  const forgedRoot = new MerkleTree(leaves.map((h) => sha256(h === log.rawHash ? forged : h)), sha256, { sortPairs: true }).getHexRoot();
  console.log("  sha256 ใหม่    :", forged);
  console.log("  root ใหม่      :", forgedRoot);
  console.log("  เทียบกับ chain :", ok(chainRoot.toLowerCase() === forgedRoot.toLowerCase()), "← ระบบจับได้ว่าเป็น TAMPERED");
})().catch((e) => { console.error("error:", e.shortMessage || e.message); process.exit(1); });
'
