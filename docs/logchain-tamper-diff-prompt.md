# Prompt for Claude Code — Batch Tamper Diff (admin view)

Paste everything below the line into Claude Code inside `~/Documents/logchain`.

---
Build a feature that lets an admin open any sealed batch, check it against the root on Polygon Amoy, and see exactly which logs changed and how (field, old value, new value). Work on a new branch `feature/tamper-diff` off main. Do NOT redeploy or change the smart contract.

## Core idea (read first)

The chain only stores one Merkle root per batch, so it alone can't say which log changed. Fix: at seal time, save a snapshot of every sealed log row. The snapshot is trusted ONLY if the Merkle root rebuilt from its leaves equals the root on chain. Since the root binds every leaf, nobody can e
dit the snapshot without that check failing. Once the snapshot is proven, diff it against the current `logs` rows.

## Step 0 — inspect before writing anything

- Read `src/integrity/integrity.service.ts`, `merkle.service.ts`, `blockchain.service.ts`, the Log entity, and `getLeavesForBatch`.
- Confirm exactly how a leaf is computed (is the leaf `raw_hash`? what fields go into `raw_hash`, in what order/encoding?) and how the root is read from chain. Report this to me before step 1.
- Keep the existing seal order `{ createdAt: 'ASC', id: 'ASC' }` — the leaf-ordering bug fixed in 2026-07 must not come back.

## Step 1 — snapshot table (migration)

New table `batch_log_snapshot`: `batch_id`, `log_id`, `position` (int, leaf index), `snapshot` (jsonb: every field that goes into `raw_hash`, plus `raw_hash` itself, as stored at seal time — already PII-masked), `created_at`. PK (`batch_id`, `log_id`). Add the same write-only trigger as `logs` (block UPDATE/DELETE).

## Step 2 — write snapshot during sealBatch

In the same transaction that writes `log_batch_mapping`, insert one snapshot row per log with its leaf position. If the snapshot insert fails, the seal must fail (no batch without a snapshot). Old batches sealed before this feature will have no snapshot — handle that as "batch-level only".

## Step 3 — diff service + endpoint

`GET /api/v1/integrity/batches/:id/diff`, `@Roles('admin','auditor')`, audited to `audit_access`. Logic:

1. Read the on-chain root for the batch.
2. Rebuild the root from snapshot leaves (by `position`). Also recompute each snapshot's `raw_hash` from its own fields.
3. If the rebuilt root ≠ chain root → `snapshotTrusted: false`, return batch-level result only (status TAMPERED, "snapshot was also modified, cannot show original values").
4. If trusted, compare each snapshot row to the current `logs` row and classify:
   - `CONTENT_MODIFIED` — a field differs → list `{ field, before, after }`
   - `HASH_MODIFIED` — fields equal but `raw_hash` differs
   - `DELETED` — log in snapshot but missing from `logs`
   - `UNMAPPED_OR_INSERTED` — mapping for this batch has a log not in the snapshot
   - `UNCHANGED`
5. Response: `{ batchId, txHash, blockNumber, polygonscanUrl, chainRoot, dbRoot, snapshotTrusted, status, summary: {total, unchanged, modified, deleted, inserted}, changes: [...] }` — `changes` lists only non-UNCHANGED logs.

Also add `GET /api/v1/integrity/batches` (paginated list with status, log_count, sealed_at, tx_hash) if no such endpoint exists.

## Step 4 — frontend (cylis-dashboard, Next.js)

New admin page "ตรวจสอบ Batch" (or a section on Verify — pick whichever fits the current nav, tell me which):
- Batch list with status badge (CONFIRMED green / UNVERIFIED amber / TAMPERED red) and Polygonscan link.
- Click a batch → "Check against blockchain" button → calls the diff endpoint.
- Show chain root vs DB root side by side, the summary counts, and a table of changed logs: log id (full UUID in title, truncated on display), change type, and per-field before → after with red/green highlighting.
- If `snapshotTrusted` is false, show a clear red banner explaining the original values can't be recovered.
- Loading / error / empty states, same pattern as the other pages.

## Step 5 — tests and demo

- Unit spec for the diff service covering every change type, untrusted snapshot, and no-snapshot (legacy batch). Mutation-check a couple of them.
- Extend `test/integrity.integration.spec.ts` (fake chain) with: seal → modify a log's message → diff shows CONTENT_MODIFIED with correct before/after.
- Update `scripts/demo-tamper.sh` so after the tamper it also calls the diff endpoint and prints the changed field; `restore` must still put everything back.
- Run `npm run test` and `npm run test:e2e`, plus `tsc --noEmit` and `next build` in the frontend. All must pass.

## Caveats to flag in the PR description

- Snapshot duplicates masked log data → RetentionService/ErasureService must also handle `batch_log_snapshot` (PDPA). Erasing a sealed log will legitimately show up as DELETED — document that the erasure log explains it.
- Legacy batches (before this feature) only get batch-level checking.

Commit with my name only — no Co-Authored-By trailer.
