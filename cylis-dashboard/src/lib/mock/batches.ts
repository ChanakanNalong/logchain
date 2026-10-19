/**
 * Mock for the Batch audit page — GET /batches and GET /batches/:id/diff
 * (docs/api/batches-diff.md). Batches that also hold logs in the Logs mock
 * (MOCK_BATCHES) reuse the same ids, roots and chain state, so a log, its
 * drawer and its batch diff tell the same story. The verdict rules mirror
 * src/integrity/batch-diff.service.ts.
 */
import type { BatchChange, BatchDiff, BatchListItem, BatchStatus, SnapshotLog } from "@/types/api";
import { MOCK_BATCHES, MOCK_LOGS, TAMPERED_SEALED_RAW, at, hex, logId, mappedLeaves, uuid } from "./data";
import { buildLayers } from "./merkleMock";

type Gas = { gasUsed: string | number; gwei: string | number } | null;

interface AuditSpec {
  item: BatchListItem;
  chainRoot: string | null;
  chainError: string | null;
  dbRoot: string;
  /** root rebuilt from the logs mapped now · null when none are mapped */
  currentRoot: string | null;
  /** logs mapped to the batch now, in seal order — the tree on the Verify page */
  leaves: { logId: string; rawHash: string }[];
  /** gas for the tree's cost block (same as the list's) */
  gas: Gas;
  /** set rates for ETH / THB conversion? (false = the "rate not configured" case) */
  rates: boolean;
  /** null = legacy (no snapshot) */
  snapshot: { root: string; contentIntact: boolean; logs: number } | null;
  mappedLogs: number;
  changes: BatchChange[];
}

const CHAIN_DOWN = "could not read root from chain: request timed out after 5000ms";

function listItem(
  id: string,
  status: BatchStatus,
  merkleRoot: string,
  txHash: string | null,
  blockNumber: number | null,
  polygonscanUrl: string | null,
  logCount: number,
  sealedAt: string,
  confirmedAt: string | null,
  gas: Gas,
  hasSnapshot = true,
  sealReason: BatchListItem["sealReason"] = "cron",
): BatchListItem {
  return {
    id, merkleRoot, txHash, blockNumber, polygonscanUrl, status, logCount, sealedAt, confirmedAt,
    sealReason,
    ifAnomaly: null, ifScore: null, ifReason: null, ifScoredAt: null,
    hasSnapshot,
    gasUsed: gas?.gasUsed ?? null,
    effectiveGasPriceGwei: gas?.gwei ?? null,
  };
}

/** A batch that also exists in the Logs mock — same id, roots and chain state */
function fromLogsMock(
  key: keyof typeof MOCK_BATCHES,
  gas: Gas,
  extra: Partial<Pick<AuditSpec, "snapshot" | "mappedLogs" | "changes">> & { logCount?: number } = {},
): AuditSpec {
  const b = MOCK_BATCHES[key];
  const i = b.info;
  let leaves = mappedLeaves(i.id);
  if (leaves.length === 0 && extra.logCount) {
    // PENDING: no Logs-mock row maps to it (mapping is written after the anchor), but the
    // tree/diff still need its sealed logs — synthetic ones, and the root built from them
    leaves = Array.from({ length: extra.logCount }, (_, n) => ({ logId: uuid(`log:${key}:${n}`), rawHash: hex(`raw:${key}:${n}`) }));
    i.merkleRoot = buildLayers(leaves.map((l) => l.rawHash)).root!.slice(2);
  }
  const logCount = extra.logCount ?? leaves.length;
  const dbRoot = "0x" + i.merkleRoot;
  const chainRoot = "error" in b.chainCheck ? null : b.chainCheck.chainRoot;
  return {
    item: listItem(i.id, i.status, i.merkleRoot, i.txHash, i.blockNumber, i.polygonscanUrl, logCount, i.sealedAt, i.confirmedAt, gas),
    chainRoot,
    chainError: "error" in b.chainCheck ? b.chainCheck.error : null,
    dbRoot,
    currentRoot: buildLayers(leaves.map((l) => l.rawHash)).root,
    leaves,
    gas,
    rates: true,
    snapshot: extra.snapshot ?? { root: dbRoot, contentIntact: true, logs: logCount },
    mappedLogs: extra.mappedLogs ?? leaves.length,
    changes: extra.changes ?? [],
  };
}

/** A batch shown only on this page (none of its logs are in the Logs mock) */
function listOnly(
  key: string,
  status: BatchStatus,
  minutesAgo: number,
  logCount: number,
  gas: Gas,
  opts: { legacy?: boolean; snapshotContentIntact?: boolean; snapshotRootRewritten?: boolean; rates?: boolean } = {},
): AuditSpec {
  // synthetic logs — real hashes, so the tree and its root are consistent
  const leaves = Array.from({ length: logCount }, (_, n) => ({ logId: uuid(`log:${key}:${n}`), rawHash: hex(`raw:${key}:${n}`) }));
  const merkleRoot = buildLayers(leaves.map((l) => l.rawHash)).root!.slice(2);
  const txHash = "0x" + hex(`tx:${key}`);
  const dbRoot = "0x" + merkleRoot;
  return {
    item: listItem(
      uuid(`batch:${key}`), status, merkleRoot, txHash, 28_000_000 + minutesAgo, "https://amoy.polygonscan.com/tx/" + txHash,
      logCount, at(minutesAgo), at(minutesAgo, 7), gas, !opts.legacy,
    ),
    chainRoot: dbRoot,
    chainError: null,
    dbRoot,
    currentRoot: dbRoot,
    leaves,
    gas,
    rates: opts.rates ?? true,
    snapshot: opts.legacy ? null : {
      root: opts.snapshotRootRewritten ? "0x" + hex(`snapshot:${key}`) : dbRoot,
      contentIntact: opts.snapshotContentIntact ?? true,
      logs: logCount,
    },
    mappedLogs: logCount,
    changes: [],
  };
}

const tampered = MOCK_BATCHES.tampered.info;
const cardLog = MOCK_LOGS.find((l) => l.item.id === logId("card"))!.item;
const insertedLog = MOCK_LOGS.find((l) => l.item.id === logId("inserted"))!.item;

const asSnapshot = (l: typeof cardLog): SnapshotLog => ({
  id: l.id, createdAt: l.createdAt, source: l.source, sourceIp: l.sourceIp, eventType: l.eventType,
  severity: l.severity, message: l.message, classification: l.classification, cdeScope: l.cdeScope, rawHash: l.rawHash,
});

/**
 * Seal order of the tampered batch (createdAt): scan-sqli 0 · priv-esc 1 ·
 * card 2 · deleted 3. Now mapped: scan-sqli, priv-esc, card, inserted.
 */
const TAMPERED_CHANGES: BatchChange[] = [
  {
    position: 1,
    logId: logId("priv-esc"),
    type: "HASH_MODIFIED",
    fields: [{ field: "rawHash", before: TAMPERED_SEALED_RAW.privEsc, after: "f".repeat(64) }],
  },
  {
    position: 2,
    logId: cardLog.id,
    type: "CONTENT_MODIFIED",
    fields: [
      { field: "severity", before: "ERROR", after: cardLog.severity },
      {
        field: "message",
        before:
          "bulk read of card_holders by svc-report (2,400 rows) — columns pan_last4, holder_name, expiry, billing_address; " +
          "query SELECT * FROM card_holders WHERE region IN ('TH','SG','MY') ORDER BY updated_at DESC",
        after: cardLog.message,
      },
      { field: "rawHash", before: TAMPERED_SEALED_RAW.card, after: cardLog.rawHash },
    ],
  },
  {
    position: 3,
    logId: logId("deleted"),
    type: "DELETED",
    reason: "ROW_MISSING",
    snapshot: {
      id: logId("deleted"), createdAt: at(34, 20), source: "app-svc-1", sourceIp: "10.0.4.30", eventType: "DATA_ACCESS",
      severity: "CRITICAL", message: "user jdoe downloaded card_holders.csv (2,400 rows) to 203.0.113.77",
      classification: "CONFIDENTIAL", cdeScope: true, rawHash: TAMPERED_SEALED_RAW.deleted,
    },
  },
  { position: 3, logId: insertedLog.id, type: "UNMAPPED_OR_INSERTED", current: asSnapshot(insertedLog) },
];

/** Newest first after sorting in getBatches */
export const AUDITS: AuditSpec[] = [
  fromLogsMock("confirmed", { gasUsed: "71240", gwei: "25" }),
  // chain unreadable + tx sent → UNVERIFIABLE (matches the "ติดต่อเชนไม่ได้" chain check in Logs)
  fromLogsMock("confirmedRpcDown", { gasUsed: 70110, gwei: 25.5 }),
  // the Logs mock's tampered batch: stored root still equals the chain, rows changed
  fromLogsMock("tampered", { gasUsed: "72001", gwei: "26" }, {
    logCount: 4, mappedLogs: 4, changes: TAMPERED_CHANGES,
  }),
  // the Logs mock's "status disagrees" batch: its stored root no longer equals the chain
  // (chain check mismatch). Root, snapshot and logs were rewritten together, so by the
  // backend rules dbRoot, currentRoot and snapshotRoot all differ from the chain → all red
  // + SNAPSHOT_ROOT_MISMATCH. For "only the snapshot was touched" see the two list-only cases below.
  fromLogsMock("confirmedMismatch", { gasUsed: "69988", gwei: "25" }),
  fromLogsMock("unverified", null),
  fromLogsMock("sealed", null),
  fromLogsMock("failed", null),
  fromLogsMock("pending", null, { logCount: 3 }),
  // list-only cases
  // rates not configured → ETH / THB null on the Verify cost card
  listOnly("single", "CONFIRMED", 60 * 3, 1, { gasUsed: "52310", gwei: "30.5" }, { rates: false }),
  listOnly("hundred", "CONFIRMED", 60 * 6, 100, { gasUsed: "78156", gwei: "25.000000031" }),
  listOnly("no-gas", "CONFIRMED", 60 * 20, 33, null),
  // only snapshot rows were edited (raw_hash left alone): roots all still match the chain
  listOnly("snapshot-edited", "TAMPERED", 60 * 26, 100, { gasUsed: "78160", gwei: "27.2" }, {
    snapshotContentIntact: false,
  }),
  // only the snapshot's raw_hash values were rewritten: snapshot root ≠ chain, db/current still match
  listOnly("snapshot-root-rewritten", "TAMPERED", 60 * 30, 15, { gasUsed: "73344", gwei: "26.5" }, {
    snapshotRootRewritten: true,
  }),
  listOnly("legacy", "CONFIRMED", 60 * 24 * 9, 7, { gasUsed: 64012, gwei: 25 }, { legacy: true }),
];

export const MOCK_BATCH_LIST: BatchListItem[] = AUDITS.map((a) => a.item).sort((a, b) =>
  b.sealedAt.localeCompare(a.sealedAt),
);

const isZero = (r: string | null) => !r || /^(0x)?0*$/i.test(r);

/** Same decisions as BatchDiffService.diff */
export function buildDiff(batchId: string): BatchDiff | null {
  const a = AUDITS.find((x) => x.item.id === batchId);
  if (!a) return null;
  const { item } = a;
  // a batch with nothing mapped any more rebuilds no root — never equal to the reference
  const anchoredOnChain = a.chainRoot !== null && !isZero(a.chainRoot);
  const reference = anchoredOnChain ? a.chainRoot! : a.dbRoot;
  const unverifiable = a.chainError !== null && !!item.txHash;
  const base = {
    batchId: item.id, status: item.status, txHash: item.txHash, blockNumber: item.blockNumber,
    polygonscanUrl: item.polygonscanUrl, chainRoot: a.chainRoot, chainError: a.chainError,
    dbRoot: a.dbRoot, currentRoot: a.currentRoot, checkedAt: new Date().toISOString(),
  };
  const unknown = { unchanged: null, contentModified: null, hashModified: null, deleted: null, unmappedOrInserted: null };

  if (!a.snapshot) {
    const intact = a.currentRoot === reference && a.dbRoot === reference;
    return {
      ...base, snapshotRoot: null, snapshotTrusted: null, trustBasis: null, untrustedReasons: [], legacy: true,
      summary: { verdict: intact ? (unverifiable ? "UNVERIFIABLE" : "INTACT") : "TAMPERED", snapshotLogs: 0, mappedLogs: a.mappedLogs, ...unknown },
      changes: [],
    };
  }

  const reasons: BatchDiff["untrustedReasons"] = [];
  if (a.snapshot.root !== reference) reasons.push("SNAPSHOT_ROOT_MISMATCH");
  if (!a.snapshot.contentIntact) reasons.push("SNAPSHOT_CONTENT_MISMATCH");
  const trustBasis = anchoredOnChain ? "chain" : "db";
  if (reasons.length) {
    return {
      ...base, snapshotRoot: a.snapshot.root, snapshotTrusted: false, trustBasis, untrustedReasons: reasons, legacy: false,
      summary: { verdict: "TAMPERED", snapshotLogs: a.snapshot.logs, mappedLogs: a.mappedLogs, ...unknown },
      changes: [],
    };
  }

  const count = (t: BatchChange["type"]) => a.changes.filter((c) => c.type === t).length;
  const touched = new Set(a.changes.filter((c) => c.type !== "UNMAPPED_OR_INSERTED").map((c) => c.position));
  const intact = a.changes.length === 0 && a.currentRoot === reference && a.dbRoot === reference;
  return {
    ...base, snapshotRoot: a.snapshot.root, snapshotTrusted: true, trustBasis, untrustedReasons: [], legacy: false,
    summary: {
      verdict: !intact ? "TAMPERED" : unverifiable ? "UNVERIFIABLE" : "INTACT",
      snapshotLogs: a.snapshot.logs,
      mappedLogs: a.mappedLogs,
      unchanged: a.snapshot.logs - touched.size,
      contentModified: count("CONTENT_MODIFIED"),
      hashModified: count("HASH_MODIFIED"),
      deleted: count("DELETED"),
      unmappedOrInserted: count("UNMAPPED_OR_INSERTED"),
    },
    changes: a.changes,
  };
}

/** used by the slow-chain delay in the mock handler */
export function diffChainIsDown(batchId: string): boolean {
  return AUDITS.find((x) => x.item.id === batchId)?.chainError != null;
}

