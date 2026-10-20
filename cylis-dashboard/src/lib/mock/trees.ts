/**
 * Mock for the Verify page — GET /batches/:id/tree and GET /logs/:id/proof
 * (docs/api/merkle-tree.md). Built from the same batches as the Batch audit
 * mock (AUDITS), with real SHA-256 layers, so roots, proofs and the browser
 * re-computation all agree. Cost follows BatchTreeService.cost().
 */
import type { BatchTree, CostTriple, LogProofResult, ProofStep, TreeCost } from "@/types/api";
import { proofPath } from "@/lib/merkle";
import { AUDITS } from "./batches";
import { buildLayers, leafHash, parentHash } from "./merkleMock";

const RATES = { polEth: "0.0000625", polThb: "7.85", asOf: "2026-10-15" };

/* exact decimals as (integer, scale) — no floats, no exponent output */
type Dec = { v: bigint; s: number };
const TEN = BigInt(10);
const parse = (x: string | number): Dec => {
  const [i, f = ""] = String(x).split(".");
  return { v: BigInt(i + f), s: f.length };
};
const fmt = ({ v, s }: Dec): string => {
  const neg = v < BigInt(0);
  const digits = (neg ? -v : v).toString().padStart(s + 1, "0");
  const int = digits.slice(0, digits.length - s);
  const frac = digits.slice(digits.length - s).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
};
const mul = (a: Dec, b: Dec): Dec => ({ v: a.v * b.v, s: a.s + b.s });
const mulInt = (a: Dec, n: number): Dec => ({ v: a.v * BigInt(n), s: a.s });
/** a / n at 18 decimals (wei precision), like the backend's divInt */
const divInt = (a: Dec, n: number): Dec =>
  a.s >= 18 ? { v: a.v / BigInt(n), s: a.s } : { v: (a.v * TEN ** BigInt(18 - a.s)) / BigInt(n), s: 18 };

function cost(gas: { gasUsed: string | number; gwei: string | number } | null, logCount: number, withRates: boolean): TreeCost | null {
  if (!gas) return null;
  const n = Math.max(logCount, 1);
  // POL = gas × gwei × 1e-9
  const pol = mul(parse(gas.gasUsed), { ...parse(gas.gwei), s: parse(gas.gwei).s + 9 });
  const perLog = divInt(pol, n);
  const oneTx = mulInt(pol, n);
  const triple = (rate: string): CostTriple => ({
    batch: fmt(mul(pol, parse(rate))),
    perLog: fmt(mul(perLog, parse(rate))),
    oneTxPerLog: fmt(mul(oneTx, parse(rate))),
  });
  return {
    gasUsed: String(gas.gasUsed),
    effectiveGasPriceGwei: String(gas.gwei),
    batchCostPol: fmt(pol),
    perLogCostPol: fmt(perLog),
    oneTxPerLogCostPol: fmt(oneTx),
    savingFactor: String(n),
    eth: withRates ? triple(RATES.polEth) : null,
    thb: withRates ? triple(RATES.polThb) : null,
    rates: withRates
      ? { polEth: RATES.polEth, polThb: RATES.polThb, asOf: RATES.asOf, source: "config" }
      : { polEth: null, polThb: null, asOf: null, source: "config" },
  };
}

export function buildTree(batchId: string): BatchTree | null {
  const a = AUDITS.find((x) => x.item.id === batchId);
  if (!a) return null;
  const built = buildLayers(a.leaves.map((l) => l.rawHash));
  const storedHashRoot = built.root ?? "";
  // mock: เนื้อหา intact ⇒ contentRoot = storedHashRoot
  return {
    batchId: a.item.id,
    status: a.item.status,
    logCount: a.item.logCount,
    txHash: a.item.txHash,
    blockNumber: a.item.blockNumber,
    polygonscanUrl: a.item.polygonscanUrl,
    dbRoot: a.dbRoot,
    snapshotRoot: a.snapshot ? a.snapshot.root : null,
    storedHashRoot,
    storedHashRootMatchesDb: storedHashRoot.toLowerCase() === a.dbRoot.toLowerCase(),
    contentRoot: storedHashRoot,
    contentRootMatchesDb: storedHashRoot.toLowerCase() === a.dbRoot.toLowerCase(),
    chainRoot: a.chainRoot,
    chainError: a.chainError,
    checkedAt: new Date().toISOString(),
    leaves: a.leaves.map((l, index) => ({ index, logId: l.logId, rawHash: l.rawHash, leafHash: leafHash(l.rawHash), contentHash: l.rawHash })),
    layers: built.layers,
    promoted: built.promoted,
    cost: cost(a.gas, a.item.logCount, a.rates),
  };
}

export function treeChainIsDown(batchId: string): boolean {
  return AUDITS.find((x) => x.item.id === batchId)?.chainError != null;
}

/** Proof of one log against the stored root — like IntegrityService.getProofForLog */
export function buildProof(logId: string): LogProofResult | null {
  for (const a of AUDITS) {
    const leafIndex = a.leaves.findIndex((l) => l.logId === logId);
    if (leafIndex < 0) continue;
    const tree = buildLayers(a.leaves.map((l) => l.rawHash));
    const path = proofPath({ layers: tree.layers }, leafIndex);
    const proof: ProofStep[] = path
      .filter((s) => s.sibling !== null)
      .map((s) => ({ position: s.siblingSide!, data: s.siblingHash! }));
    // fold the proof the way MerkleTree.verify does, then compare with the DB root
    let acc = leafHash(a.leaves[leafIndex].rawHash);
    for (const p of proof) acc = parentHash(acc, p.data);
    return {
      logId,
      rawHash: a.leaves[leafIndex].rawHash,
      // mock: เนื้อหา intact ⇒ contentHash = rawHash, integrity = INTACT
      contentHash: a.leaves[leafIndex].rawHash,
      integrity: "INTACT",
      leafIndex,
      leafHash: leafHash(a.leaves[leafIndex].rawHash),
      batch: {
        id: a.item.id,
        merkleRoot: a.item.merkleRoot,
        txHash: a.item.txHash,
        blockNumber: a.item.blockNumber,
        status: a.item.status,
        ifAnomaly: a.item.ifAnomaly ?? null,
        ifReason: a.item.ifReason ?? null,
      },
      proof,
      // mock: ถือ dbRoot เป็น root บนเชน (ไม่มีเชนจริง) · verify เทียบกับ root นั้น
      verify: acc.toLowerCase() === a.dbRoot.toLowerCase(),
      chainVerifiable: true,
      chainRoot: a.dbRoot,
      chainError: null,
      baseline: "snapshot",
    };
  }
  return null;
}
