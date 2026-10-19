/**
 * Mock dataset for NEXT_PUBLIC_USE_MOCK=1 — shaped like docs/api/logs-alerts.md.
 * Covers the states that are hard to produce on a real stack: every batch
 * status, every chainCheck outcome, and alerts holding all four log roles.
 * Fixed values only (no Math.random) so every reload shows the same rows.
 */
import type { AlertItem, AlertLogRole, BatchInfo, BatchStatus, ChainCheck, LogItem, LogProof } from "@/types/api";
import { buildLayers } from "./merkleMock";

const EXPLORER = "https://amoy.polygonscan.com/tx/";
const BASE_TIME = Date.parse("2026-10-15T10:00:00.000Z");

/**
 * Deterministic hex of the given length, seeded by a string. FNV-1a over the
 * seed, then a murmur3-style finaliser per 8-hex word — similar seeds must give
 * unrelated ids, or rows like brute-window-0..3 read almost the same on screen.
 */
export function hex(seed: string, len = 64): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let out = "";
  while (out.length < len) {
    h = (h + 0x9e3779b9) | 0;
    let z = h;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    z ^= z >>> 16;
    out += (z >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

/** Deterministic v4-looking UUID */
export function uuid(seed: string): string {
  const x = hex(`uuid:${seed}`, 32);
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

export function at(minutesAgo: number, seconds = 0): string {
  return new Date(BASE_TIME - minutesAgo * 60_000 + seconds * 1000).toISOString();
}

export const ZERO_ROOT = "0x" + "0".repeat(64);

interface MockBatch {
  info: BatchInfo;
  /** how the chain compares — applied once the real root is known (finalizeBatchRoots) */
  chainMode: "match" | "mismatch" | "zero" | "error";
  /** what GET /logs/:id/detail returns for every log of this batch */
  chainCheck: Omit<Extract<ChainCheck, { match: boolean }>, "checkedAt"> | { error: string };
}

function batch(
  key: string,
  status: BatchStatus,
  minutesAgo: number,
  opts: { anchored: boolean; chain: "match" | "mismatch" | "zero" | "error" },
): MockBatch {
  const merkleRoot = hex(`root:${key}`);
  const txHash = opts.anchored ? "0x" + hex(`tx:${key}`) : null;
  const dbRoot = "0x" + merkleRoot;
  const chainCheck =
    opts.chain === "error"
      ? { error: "could not read root from chain: request timed out after 5000ms" }
      : {
          dbRoot,
          chainRoot: opts.chain === "match" ? dbRoot : opts.chain === "zero" ? ZERO_ROOT : "0x" + hex(`chain:${key}`),
          match: opts.chain === "match",
        };
  return {
    info: {
      id: uuid(`batch:${key}`),
      status,
      merkleRoot,
      txHash,
      blockNumber: opts.anchored ? 28451000 + minutesAgo * 7 : null,
      polygonscanUrl: txHash ? EXPLORER + txHash : null,
      sealedAt: at(minutesAgo),
      confirmedAt: status === "CONFIRMED" || status === "TAMPERED" ? at(minutesAgo, 6) : null,
    },
    chainCheck,
    chainMode: opts.chain,
  };
}

/** Chain check of a batch for its (final) stored root */
function chainCheckFor(key: string, mode: MockBatch["chainMode"], dbRoot: string): MockBatch["chainCheck"] {
  if (mode === "error") return { error: "could not read root from chain: request timed out after 5000ms" };
  return {
    dbRoot,
    chainRoot: mode === "match" ? dbRoot : mode === "zero" ? ZERO_ROOT : "0x" + hex(`chain:${key}`),
    match: mode === "match",
  };
}

/** One batch per state the UI has to draw */
export const MOCK_BATCHES = {
  confirmed: batch("confirmed", "CONFIRMED", 50, { anchored: true, chain: "match" }),
  // 3c: sealed and anchored, but the RPC is down right now
  confirmedRpcDown: batch("confirmed-rpc-down", "CONFIRMED", 40, { anchored: true, chain: "error" }),
  // the usual tamper case: a row was edited after seal (caught by its raw hash)
  // while the stored root was left alone — so the stored root still matches the chain
  tampered: batch("tampered", "TAMPERED", 35, { anchored: true, chain: "match" }),
  // every kind of change in one batch, for the "at seal | now" compare (lib/mock/batches.ts):
  // content edited with and without re-hashing, hash only, row deleted, mapping deleted,
  // a log inserted, one log left alone — the stored root still matches the chain
  tamperedFull: batch("tampered-full", "TAMPERED", 31, { anchored: true, chain: "match" }),
  // status from an older round disagrees with the live check → drawer shows the "recheck" note
  confirmedMismatch: batch("confirmed-mismatch", "CONFIRMED", 25, { anchored: true, chain: "mismatch" }),
  // tx was sent but verify found no root on chain (backend `MISSING`)
  unverified: batch("unverified", "UNVERIFIED", 20, { anchored: true, chain: "zero" }),
  // sealed without anchoring → chain still holds 0x000… for this batch
  sealed: batch("sealed", "SEALED", 15, { anchored: false, chain: "zero" }),
  // anchoring gave up
  failed: batch("failed", "FAILED", 10, { anchored: false, chain: "zero" }),
  pending: batch("pending", "PENDING", 5, { anchored: false, chain: "zero" }),
} satisfies Record<string, MockBatch>;

type BatchKey = keyof typeof MOCK_BATCHES;

interface Seed {
  key: string;
  minutesAgo: number;
  seconds?: number;
  source: string;
  sourceIp: string | null;
  eventType: string;
  severity: string;
  message: string;
  batch: BatchKey | null;
  cdeScope?: boolean;
  /** override the stored hash (a HASH_MODIFIED row in the batch diff mock) */
  rawHash?: string;
}

/** The same hash with a few digits rewritten — the HASH_MODIFIED row of tamperedFull */
function rewriteHex(h: string): string {
  const flip = (c: string) => ((parseInt(c, 16) + 7) % 16).toString(16);
  return h.split("").map((c, i) => (i === 9 || i === 10 || i === 11 || i === 40 || i === 63 ? flip(c) : c)).join("");
}

const BRUTE_IP = "203.0.113.5";
const SCAN_IP = "198.51.100.9";

const SEEDS: Seed[] = [
  // brute force on sshd → alert 5710 (trigger + window + repeat) and 5715 (prior)
  ...[0, 1, 2, 3].map((i): Seed => ({
    key: `brute-window-${i}`, minutesAgo: 51, seconds: i * 1.3, source: "vps-sshd", sourceIp: BRUTE_IP,
    eventType: "SSH_AUTH", severity: "WARNING",
    message: `Failed password for root from 203.0.113.xxx port ${52314 + i} ssh2`, batch: "confirmed",
  })),
  {
    key: "brute-trigger", minutesAgo: 51, seconds: 6, source: "vps-sshd", sourceIp: BRUTE_IP,
    eventType: "SSH_AUTH", severity: "WARNING",
    message: "Failed password for root from 203.0.113.xxx port 52318 ssh2", batch: "confirmed",
  },
  {
    key: "brute-success", minutesAgo: 49, source: "vps-sshd", sourceIp: BRUTE_IP,
    eventType: "SSH_AUTH", severity: "INFO",
    message: "Accepted password for root from 203.0.113.xxx port 52401 ssh2", batch: "confirmed",
  },
  {
    key: "brute-repeat", minutesAgo: 2, source: "vps-sshd", sourceIp: BRUTE_IP,
    eventType: "SSH_AUTH", severity: "WARNING",
    message: "Failed password for root from 203.0.113.xxx port 52519 ssh2", batch: null,
  },
  // web scanner on nginx
  {
    key: "scan-env", minutesAgo: 41, source: "web-proxy", sourceIp: SCAN_IP,
    eventType: "HTTP_ACCESS", severity: "WARNING", message: 'GET /.env 404 "zgrab/0.x"', batch: "confirmedRpcDown",
  },
  {
    key: "scan-git", minutesAgo: 41, seconds: 2, source: "web-proxy", sourceIp: SCAN_IP,
    eventType: "HTTP_ACCESS", severity: "WARNING", message: 'GET /.git/config 404 "zgrab/0.x"', batch: "confirmedRpcDown",
  },
  {
    key: "scan-sqli", minutesAgo: 36, source: "web-proxy", sourceIp: SCAN_IP,
    eventType: "HTTP_ACCESS", severity: "WARNING",
    message: "GET /item?id=1%20UNION%20SELECT%20password%20FROM%20users 400 \"sqlmap/1.8\"", batch: "tampered",
  },
  // app traffic spread over the other batches
  {
    key: "priv-esc", minutesAgo: 35, source: "auth-service", sourceIp: "10.0.4.21",
    eventType: "PRIV_ESC", severity: "CRITICAL", message: "user jdoe added to group sudo by uid 1001", batch: "tampered",
    // only raw_hash was rewritten (HASH_MODIFIED) — content still as sealed
    rawHash: "f".repeat(64),
  },
  // edited after seal: lib/mock/batches.ts holds the seal-time version
  // (ERROR, "bulk read … 2,400 rows") — this is what the row says now
  {
    key: "card", minutesAgo: 34, source: "app-svc-1", sourceIp: "10.0.4.30",
    eventType: "CARD_ACCESS", severity: "INFO", message: "scheduled report read card_holders (12 rows)",
    batch: "tampered", cdeScope: true,
  },
  // not in the seal-time snapshot, mapped to the tampered batch later (UNMAPPED_OR_INSERTED)
  {
    key: "inserted", minutesAgo: 34, seconds: 40, source: "app-svc-1", sourceIp: "10.0.4.30",
    eventType: "USER_ACTIVITY", severity: "INFO", message: "card_holders export approved by admin (ticket CHG-1042)",
    batch: "tampered",
  },
  // ── tamperedFull: lib/mock/batches.ts holds the seal-time values ──
  // untouched since seal
  {
    key: "tf-ok", minutesAgo: 33, source: "pos-gw-2", sourceIp: "10.0.6.11",
    eventType: "PAYMENT_AUTH", severity: "INFO", message: "authorization approved at terminal T-0442 (1,250.00 THB)",
    batch: "tamperedFull", cdeScope: true,
  },
  // edited and re-hashed: sourceIp → null, severity, message, cdeScope / classification
  {
    key: "tf-multi", minutesAgo: 33, seconds: 10, source: "pos-gw-2", sourceIp: null,
    eventType: "PAYMENT_AUTH", severity: "INFO", message: "authorization retried at terminal T-0442",
    batch: "tamperedFull",
  },
  // edited without touching raw_hash: sourceIp null → value, message
  {
    key: "tf-content", minutesAgo: 33, seconds: 20, source: "report-svc", sourceIp: "198.51.100.23",
    eventType: "DATA_EXPORT", severity: "WARNING", message: "export of settlement_report.csv cancelled by user mchan",
    batch: "tamperedFull",
  },
  // only raw_hash rewritten (a few hex digits) — content as sealed
  {
    key: "tf-hash", minutesAgo: 33, seconds: 30, source: "auth-service", sourceIp: "10.0.6.20",
    eventType: "AUTH_SUCCESS", severity: "INFO", message: "login ok for user ops-admin (mfa)",
    batch: "tamperedFull", rawHash: rewriteHex(hex("raw:tf-hash")),
  },
  // the row is still here but its mapping to the batch was deleted (DELETED · MAPPING_MISSING)
  {
    key: "tf-mapping", minutesAgo: 32, source: "app-svc-2", sourceIp: "10.0.6.40",
    eventType: "CONFIG_CHANGE", severity: "WARNING", message: "firewall rule fw-17 (allow 0.0.0.0/0 to 10.0.6.0/24:22) added by ops-bot",
    batch: null,
  },
  // not in the snapshot, mapped to the batch later (UNMAPPED_OR_INSERTED)
  {
    key: "tf-inserted", minutesAgo: 32, seconds: 40, source: "app-svc-2", sourceIp: "10.0.6.40",
    eventType: "CONFIG_CHANGE", severity: "INFO", message: "firewall change CHG-2077 approved by security team",
    batch: "tamperedFull",
  },
  ...Array.from({ length: 8 }, (_, i): Seed => ({
    key: `web-${i}`, minutesAgo: 30 - i, source: "app-web-1", sourceIp: `192.0.2.${10 + i}`,
    eventType: "WEB_REQUEST", severity: i % 4 === 3 ? "ERROR" : "INFO",
    message: i % 4 === 3 ? `POST /api/orders 500 upstream timeout (req ${1000 + i})` : `GET /api/products?page=${i} 200`,
    batch: i < 3 ? "unverified" : i < 6 ? "sealed" : "failed",
  })),
  ...Array.from({ length: 6 }, (_, i): Seed => ({
    key: `auth-${i}`, minutesAgo: 22 - i * 2, source: "auth-service", sourceIp: `10.0.5.${40 + i}`,
    eventType: i % 3 === 0 ? "AUTH_FAILURE" : "AUTH_SUCCESS", severity: i % 3 === 0 ? "WARNING" : "INFO",
    message: i % 3 === 0 ? `login failed for user user${i}: bad password` : `login ok for user user${i}`,
    batch: i < 2 ? "unverified" : i < 4 ? "sealed" : i === 4 ? "failed" : "confirmedMismatch",
  })),
  ...Array.from({ length: 6 }, (_, i): Seed => ({
    key: `db-${i}`, minutesAgo: 9 - i, source: "app-svc-1", sourceIp: null,
    eventType: "DB_QUERY", severity: i === 0 ? "DEBUG" : "INFO",
    message: `query orders_by_customer took ${120 + i * 15}ms`,
    // PENDING batches have no log mapping yet (written after the anchor), so no log
    // ever shows a PENDING batch — these stay unsealed (batchStatus null)
    batch: null,
  })),
  {
    key: "ssh-invalid", minutesAgo: 1, source: "vps-sshd", sourceIp: "2001:db8::1",
    eventType: "SSH_AUTH", severity: "WARNING", message: "Invalid user oracle from 2001:db8::1 port 40022", batch: null,
  },
  {
    key: "nginx-wp", minutesAgo: 0, seconds: -20, source: "web-proxy", sourceIp: "198.51.100.77",
    eventType: "HTTP_ACCESS", severity: "WARNING", message: 'GET /wp-login.php 404 "Mozilla/5.0"', batch: null,
  },
];

export interface MockLog {
  item: LogItem;
  batch: MockBatch | null;
  proof: LogProof | null;
}

function buildLog(s: Seed): MockLog {
  const b = s.batch ? MOCK_BATCHES[s.batch] : null;
  const item: LogItem = {
    id: uuid(`log:${s.key}`),
    createdAt: at(s.minutesAgo, s.seconds ?? 0),
    source: s.source,
    sourceIp: s.sourceIp,
    eventType: s.eventType,
    severity: s.severity,
    message: s.message,
    classification: s.cdeScope ? "CONFIDENTIAL" : "INTERNAL",
    cdeScope: s.cdeScope ?? false,
    retentionDays: s.cdeScope ? 365 * 7 : 365,
    rawHash: s.rawHash ?? hex(`raw:${s.key}`),
    batchId: b?.info.id ?? null,
    batchStatus: b?.info.status ?? null,
    txHash: b?.info.txHash ?? null,
    blockNumber: b?.info.blockNumber ?? null,
    polygonscanUrl: b?.info.polygonscanUrl ?? null,
  };
  // the drawer's proof is built by the mock handler from the batch's real tree (lib/mock/trees.ts)
  const proof: LogProof | null = null;
  return { item, batch: b, proof };
}

/** Newest first, like the backend */
export const MOCK_LOGS: MockLog[] = SEEDS.map(buildLog).sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));

/**
 * raw_hash values of the tampered batch at seal time (what the snapshot and
 * the stored root were built from) — the rows were changed afterwards.
 */
export const TAMPERED_SEALED_RAW = {
  privEsc: hex("raw:priv-esc"),
  card: hex("raw:card:sealed"),
  deleted: hex("raw:deleted"),
};

/** raw_hash values of tamperedFull at seal, in seal order (createdAt ASC) */
export const TAMPERED_FULL_SEALED_RAW = {
  ok: hex("raw:tf-ok"),
  multi: hex("raw:tf-multi:sealed"),
  content: hex("raw:tf-content"),
  hash: hex("raw:tf-hash"),
  mapping: hex("raw:tf-mapping"),
  deleted: hex("raw:tf-deleted"),
};

/** Leaves in seal order (createdAt ASC, id ASC) of the logs mapped to a batch now */
export function mappedLeaves(batchId: string): { logId: string; rawHash: string }[] {
  return MOCK_LOGS.map((l) => l.item)
    .filter((l) => l.batchId === batchId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((l) => ({ logId: l.id, rawHash: l.rawHash }));
}

/**
 * Real Merkle roots: each batch's stored root is built (sha256) from the
 * raw hashes it was sealed with, and its chain check follows from that root.
 */
function finalizeBatchRoots() {
  for (const [key, b] of Object.entries(MOCK_BATCHES) as [BatchKey, MockBatch][]) {
    let sealed = mappedLeaves(b.info.id).map((l) => l.rawHash);
    if (key === "tampered") {
      // seal order: scan-sqli, priv-esc, card, deleted
      sealed = [hex("raw:scan-sqli"), TAMPERED_SEALED_RAW.privEsc, TAMPERED_SEALED_RAW.card, TAMPERED_SEALED_RAW.deleted];
    }
    if (key === "tamperedFull") {
      // seal order: tf-ok, tf-multi, tf-content, tf-hash, tf-mapping, tf-deleted
      const r = TAMPERED_FULL_SEALED_RAW;
      sealed = [r.ok, r.multi, r.content, r.hash, r.mapping, r.deleted];
    }
    const root = buildLayers(sealed).root;
    if (!root) continue; // no logs mapped (PENDING) — keep the placeholder root
    b.info.merkleRoot = root.slice(2);
    b.chainCheck = chainCheckFor(key, b.chainMode, root);
  }
}
finalizeBatchRoots();

export const logId = (key: string) => uuid(`log:${key}`);

export interface MockAlert {
  alert: AlertItem;
  links: { logId: string; role: AlertLogRole }[];
}

function mockAlert(key: string, a: Omit<AlertItem, "id">, links: MockAlert["links"]): MockAlert {
  return { alert: { id: uuid(`alert:${key}`), ...a }, links };
}

export const MOCK_ALERTS: MockAlert[] = [
  mockAlert(
    "brute",
    {
      logId: logId("brute-trigger"), batchId: null, alertType: "RULE_MATCH", ruleId: "5710", severity: "CRITICAL",
      source: "vps-sshd", sourceIp: BRUTE_IP, title: "Multiple authentication failures (brute force)",
      detail: {
        rule_id: 5710, reason: "Multiple authentication failures (brute force)", confidence: null,
        log_message: "Failed password for root from 203.0.113.xxx port 52318 ssh2", event_type: "SSH_AUTH",
        ip_intel: { ip: BRUTE_IP, reputation: { available: false } },
      },
      status: "OPEN", occurrenceCount: 2, createdAt: at(51, 7), lastSeenAt: at(2, 1), lastNotifiedAt: at(51, 7),
    },
    [
      { logId: logId("brute-trigger"), role: "trigger" },
      ...[0, 1, 2, 3].map((i) => ({ logId: logId(`brute-window-${i}`), role: "window" as const })),
      { logId: logId("brute-repeat"), role: "repeat" },
    ],
  ),
  mockAlert(
    "brute-success",
    {
      logId: logId("brute-success"), batchId: null, alertType: "RULE_MATCH", ruleId: "5715", severity: "CRITICAL",
      source: "vps-sshd", sourceIp: BRUTE_IP, title: "Successful login after multiple failures",
      detail: { rule_id: 5715, reason: "Authentication success after brute force", event_type: "SSH_AUTH" },
      status: "OPEN", occurrenceCount: 1, createdAt: at(49, 1), lastSeenAt: at(49, 1), lastNotifiedAt: at(49, 1),
    },
    [
      { logId: logId("brute-success"), role: "trigger" },
      { logId: logId("brute-trigger"), role: "prior" },
      ...[0, 1, 2, 3].map((i) => ({ logId: logId(`brute-window-${i}`), role: "prior" as const })),
    ],
  ),
  mockAlert(
    "scanner",
    {
      logId: logId("scan-git"), batchId: null, alertType: "RULE_MATCH", ruleId: "31151", severity: "WARNING",
      source: "web-proxy", sourceIp: SCAN_IP, title: "Web scanner probing sensitive paths",
      detail: { rule_id: 31151, reason: "Requests for /.env and /.git from one IP", event_type: "HTTP_ACCESS" },
      status: "RESOLVED", occurrenceCount: 1, createdAt: at(41, 3), lastSeenAt: at(41, 3), lastNotifiedAt: at(41, 3),
    },
    [
      { logId: logId("scan-git"), role: "trigger" },
      { logId: logId("scan-env"), role: "window" },
    ],
  ),
  mockAlert(
    "sqli",
    {
      logId: logId("scan-sqli"), batchId: null, alertType: "RULE_MATCH", ruleId: "31103", severity: "HIGH",
      source: "web-proxy", sourceIp: SCAN_IP, title: "SQL injection attempt",
      detail: { rule_id: 31103, reason: "UNION SELECT in query string", event_type: "HTTP_ACCESS" },
      status: "OPEN", occurrenceCount: 1, createdAt: at(36, 1), lastSeenAt: at(36, 1), lastNotifiedAt: at(36, 1),
    },
    [{ logId: logId("scan-sqli"), role: "trigger" }],
  ),
  mockAlert(
    "tamper",
    {
      logId: null, batchId: MOCK_BATCHES.tampered.info.id, alertType: "INTEGRITY_TAMPERED", ruleId: null,
      severity: "CRITICAL", source: "integrity", sourceIp: null, title: "Batch root does not match the on-chain root",
      detail: {
        // stored root still equals the chain; the root recomputed from the rows does not
        recomputedRoot: "0x" + hex("recomputed:tampered"),
        onChainRoot: "0x" + MOCK_BATCHES.tampered.info.merkleRoot,
        modifiedLogIds: [logId("card"), logId("priv-esc")],
      },
      status: "OPEN", occurrenceCount: 1, createdAt: at(12), lastSeenAt: at(12), lastNotifiedAt: at(12),
    },
    [],
  ),
  mockAlert(
    "ml",
    {
      logId: logId("priv-esc"), batchId: null, alertType: "ML_ANOMALY", ruleId: null, severity: "MEDIUM",
      source: "auth-service", sourceIp: "10.0.4.21", title: "DeepLog: unexpected log key sequence",
      detail: { confidence: 0.87, sequence_length: 10 },
      status: "OPEN", occurrenceCount: 1, createdAt: at(35, 2), lastSeenAt: at(35, 2), lastNotifiedAt: null,
    },
    [{ logId: logId("priv-esc"), role: "trigger" }],
  ),
];
