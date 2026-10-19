# Phase 0 — code facts before the committee revisions

> Read-only inspection, 2026-10-15, HEAD `588869e` (`~/Documents/logchain` is a symlink to `/srv/lcsecure/home/logchain`).
> No source, config, migration or test was changed. No commit. No DB writes, no API calls, no tx.
> **Stack state at inspection time:** postgres/kafka/keycloak up; `logchain-backend` and `logchain-detection-consumer`
> **Exited (137) 4 h ago**, `logchain-vault` restarting ("Up < 1 s, health: starting"). Read-only SQL was run against
> `logchain-postgres` inside `BEGIN READ ONLY`. Nothing was restarted.
> Rule-matching was run with throwaway scripts in the session scratchpad (not in the repo), importing
> `detection/app/rules.py` and the compiled `dist/logs/services/pii-masking.service.js` (built 2026-10-14, source unchanged since 2026-09-17).
>
> Path note: the brief says `logchain-detection/rules/security_rules.yaml`. That repo was deleted 2026-09-23
> (`docs/plan/next-steps.md` §3.3). The live rules are **`detection/rules/security_rules.yaml`** + **`detection/app/rules.py`**.

---

## A. Ingest & auth

### 1. `CreateLogDto` — `src/logs/dto/create-log.dto.ts`

| Field | Type | Req? | Validation | Line |
|---|---|---|---|---|
| `source` | string | **required** | `IsString`, `IsNotEmpty`, `MaxLength(128)` (`SOURCE_MAX_LENGTH`) | 26-30 (const at 20) |
| `sourceIp` | string | optional | `IsOptional`, `IsIP()` (v4 or v6) | 32-35 |
| `eventType` | string | **required** | `IsString`, `IsNotEmpty`, `MaxLength(64)` | 37-41 |
| `severity` | string | optional (default `'INFO'`) | `IsIn(DEBUG, INFO, WARNING, ERROR, CRITICAL)` | 43-48 |
| `message` | string | **required** | `IsString`, `IsNotEmpty`, **`MaxLength(10_000)`** | 50-54 |
| `classification` | string | optional (default `'INTERNAL'`) | `IsIn(CONFIDENTIAL, INTERNAL, PUBLIC)` | 56-61 |
| `cdeScope` | boolean | optional (default `false`) | `IsOptional`, `IsBoolean` | 63-67 |
| `retentionDays` | int | optional (default 365) | `Type(Number)`, `IsInt`, `Min(1)`, `Max(3650)` | 69-78 |

- Yes, there is a `sourceIp` field and a `source` field. There is no `hostname`, `program`, `timestamp` or `raw` field.
  The client cannot set the event time: `createdAt` is set by the server at ingest (`src/logs/logs.service.ts:37`).
- The DB column for `sourceIp` is called **`source_id`** (type `inet`), not `source_ip` (`src/logs/entities/log.entity.ts:19-20`,
  `infra/postgres/init/02-schema.sql:8`). Use the right name in raw SQL.
- IPv6 is normalised before hashing and insert (`src/logs/services/log-hash.ts:41-50`, `logs.service.ts:38`).
- Rate limit: `POST /logs` allows 500 req/min per client IP (`src/logs/logs.controller.ts:31`). The global limit is 200/min (`src/app.module.ts:48`). `trust proxy` is 1 (`src/main.ts:25`).

### 2. `POST /api/v1/logs` — guards and machine auth

- Global prefix `api/v1` (`src/main.ts:31`). The controller uses `@UseGuards(AuthGuard('jwt'), RolesGuard)` (`src/logs/logs.controller.ts:23`).
  The handler uses **`@Roles('ingestor', 'admin')`** (`:30`). `RolesGuard` checks the top-level `roles` claim (`src/auth/guards/roles.guard.ts:25-31`, `src/auth/strategies/jwt.strategy.ts:52-62`).
- The JWT is RS256 and checked against Keycloak JWKS. The **issuer must equal `${KEYCLOAK_URL}/realms/logchain` exactly** (`jwt.strategy.ts:17-23, 37-49`).
  Keycloak pins `iss` with `KC_HOSTNAME_URL: ${KEYCLOAK_URL}` (`docker-compose.yml:105`). A VPS can get its token from any reachable Keycloak URL and the `iss` stays the configured one.
- **Existing machine client: `log-ingestor`**. It is a confidential client: `serviceAccountsEnabled: true`, standard flow off, direct grants off, plus a realm-roles→`roles` mapper (`infra/keycloak/realm-logchain.json.template:45-68`).
  Its service-account user is `service-account-log-ingestor` with realm role **`ingestor`** only (`:137-142`). The flow is **`grant_type=client_credentials`**.
  The access token lives 900 s (`:8`).
- Secret: `LOGCHAIN_INGESTOR_SECRET` in `.env` (`.env.example:84`). It is substituted into the realm import (`docker-compose.yml:71,78`) and seeded into Vault at
  **`secret/logchain/keycloak` field `ingestor_secret`** (`infra/vault/init.sh:47-51`). The backend reads it as `ingestorSecret` (`src/vault/vault.service.ts:11,119`) but does not need it to validate tokens.
  Reference client script: `scripts/ingest-log.sh` (client id `log-ingestor`, `:28`).
- **Can the VPS forwarder reuse it?** Yes, it works today with no code change. Recommendation: create a separate client (e.g. `vps-forwarder`, same `ingestor` role).
  Then the VPS secret can be revoked without breaking `demo-*.sh` and the scripts that share `log-ingestor`. That is a Keycloak admin-console change, not code. The cloud realm must get the same change.

### 3. PII masking — `src/logs/services/pii-masking.service.ts`

`mask()` is applied **only to `message`** (`src/logs/logs.service.ts:30`). It runs before hashing, insert and Kafka publish, so detection only ever sees the masked text (`logs.service.ts:41-80`).
The rules are applied in this order (`pii-masking.service.ts:19-49`):

| Rule | Regex | Replacement |
|---|---|---|
| email | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | `[EMAIL]` |
| thai_national_id | `\b\d{1}-?\d{4}-?\d{5}-?\d{2}-?\d{1}\b` | `[THAI_ID]` |
| phone_th | `\b0[689]\d[\s-]?\d{3}[\s-]?\d{4}\b` | `[PHONE]` |
| credit_card | `\b(?:\d{4}[\s-]?){3}\d{4}\b` | `[PAN]` |
| ipv4_last_octet | `\b(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}\b` | `$1.xxx` |

Effect on raw sshd/nginx lines (verified by running the compiled service):
- **IPs inside `message` are altered**: `from 203.0.113.5 port` becomes `from 203.0.113.xxx port`. The stored message and the hash both use the masked form.
- **Usernames are not masked** (`root`, `admin`, `kan` survive). Ports, paths and user agents survive.
- **`sourceIp` is not masked.** The full attacker IP is stored in `logs.source_id`, sent to Kafka and to the alert's `source_ip` (`logs.service.ts:38,44,57,73`).
  So the per-IP link survives through `sourceIp`, but only if the forwarder parses the IP out of the line and sends it as `sourceIp`.
- Side effects to know: a 13-digit number (e.g. an epoch-ms timestamp) becomes `[THAI_ID]`. A 16-digit number becomes `[PAN]`, and the word "PAN" then triggers rule 90001 (see item 4).

---

## B. Detection rules

### 4. The 9 rules — `detection/rules/security_rules.yaml` + `detection/app/rules.py`

How the engine works (`rules.py:43-109`):
- Only `message`, `eventType`, `cdeScope`, `source` and `createdAt` are read (`:48-55`). **`sourceIp` is never used by the rule engine.**
- Each regex is `re.search` on the masked `message` (`:72`). A rule with no patterns matches on its filters alone (`:70-75`).
- Threshold and chained state are keyed by **`(rule_id, source)`** (`:79`, `:94`, `:99`). The time base is the event `createdAt`, not the receive time (`:52-55`, `:112-123`).
  The history deque keeps 100 entries per key (`:38`).
- `eventType` is used only by 90002. `severity` in the YAML is the alert severity, not a filter.

| Rule (YAML lines) | Matches (on `message`, case-insensitive unless noted) | Filters | Severity | Threshold / window | Grouping key |
|---|---|---|---|---|---|
| **5710** (15-24) | `authentication.{0,20}fail` · `login.{0,20}(fail\|denied\|invalid)` · `wrong password` | – | CRITICAL | **≥5 matches in 60 s** (`count: 5`, `window_seconds: 60`) | `(5710, source)` |
| **5715** (26-32) | `login.{0,20}success` | needs 5710 to have **fired** for the same `source` within 300 s | WARNING | chained, `window_seconds: 300` | `(5710, source)` lookup |
| 5820 (35-42) | `sudo.{0,30}(root\|admin)` · `privilege.{0,20}(escalat\|elevat)` · `unauthorized.{0,20}(escalat\|access)` · `setuid.{0,10}0` | – | CRITICAL | none | – |
| **31100** (45-51) | `(union\s+select\|or\s+1\s*=\s*1\|';\s*drop\s+table)` · `(--\s*$\|/\*.*\*/)` · `0x[0-9a-f]{8,}` | – | CRITICAL | none | – |
| **31151** (53-59) | `(;\s*(rm\|cat\|wget\|curl\|nc)\s)` · `` (\$\(.*\)\|`.*`) `` · `(\.\./){2,}` | – | CRITICAL | none | – |
| **90001** (62-69) | `(card\|pan\|cvv\|cardholder)`, **no word boundary** | `cdeScope == false` | CRITICAL | none | – (sent to `alerts.cde`) |
| **90002** (71-76) | no pattern (filter-only) | `eventType in [PAYMENT, CARD_ACCESS]` and `cdeScope == true` | WARNING | none | – (`alerts.cde`) |
| **60001** (79-84) | `(sqlmap\|nikto\|nmap\|burp\|metasploit\|hydra)` · `(bot\|crawler\|spider).{0,20}admin` | – | WARNING | none | – |
| **60002** (86-91) | `(\.\./\|\.\.\\)` (case-sensitive) · `(?i)(/etc/passwd\|/etc/shadow\|c:\\windows)` | – | CRITICAL | none | – |

Threshold behaviour (verified): 5 matching lines in 60 s → no alert for lines 1-4, then 5710 on the 5th, and again on the 6th.
A later `login success` on the same `source` → 5715. The same line on a different `source` → nothing.
**The grouping key is the `source` string, not the IP.** One VPS that sends everything as `source: "vps-01"` counts all attackers together.

### 5. The test strings (fresh engine per line; `source=vps-01`, `eventType=SYSLOG`, `cdeScope=false`; raw and masked forms give the same result)

| # | Input | Masked `message` | First match | Other rules whose patterns also hit |
|---|---|---|---|---|
| 1 | `Failed password for root from 203.0.113.5 port 52314 ssh2` | `…203.0.113.xxx…` | **none** | none |
| 2 | `Failed password for invalid user admin from … ssh2` | IP masked | **none** | none |
| 3 | `Invalid user admin from 203.0.113.5 port 52314` | IP masked | **none** | none |
| 4 | `Accepted publickey for kan from … ED25519 SHA256:xxxx` | IP masked | **none** | none |
| 5 | `GET /.env HTTP/1.1 404 "Mozilla/5.0 zgrab/0.x"` | unchanged | **none** (`zgrab` is not in 60001) | none |
| 6 | `GET /../../etc/passwd HTTP/1.1 400 "curl/8.0"` | unchanged | **31151** (`(\.\./){2,}`) | 60002 (both patterns) |
| 7 | `GET /index.php?id=1%20UNION%20SELECT%201,2 … "sqlmap/1.7"` | unchanged | **60001** (`sqlmap`) | none. **31100 misses**: `union\s+select` does not match the URL-encoded `%20` |
| 8 | `GET / HTTP/1.1 200 "Mozilla/5.0 (Windows NT 10.0)"` | unchanged | **none** ✔ | none |

**None of the sshd lines hit 5710, and none of them can hit 5715.** 5710 needs `authentication…fail`, `login…fail/denied/invalid` or `wrong password`.
5715 needs `login…success`. sshd writes `Failed password` / `Invalid user` / `Accepted publickey|password`.
(For contrast: a PAM line such as `pam_unix(sshd:auth): authentication failure; rhost=…` does match 5710.)
Setting `eventType` on the forwarder side will not help, because these rules have no `event_types`.

Extra probes:
- `"… session opened by company panel"` → **90001** (the substring `pan` in "company"/"panel").
- `"card [PAN] masked"` → 90001. Any 16-digit number in a line becomes `[PAN]` and then fires 90001.

### 6. Evaluation order

**First match wins, in YAML order.** The engine loops over `self.rules` and `return`s on the first full match (`rules.py:57, 101-107`). The engine evaluates nothing after that.
The consumer then also skips DeepLog for that event (`detection/app/consumer.py:222-232`, `continue`).
- `(\.\./){2,}` → **31151 (YAML line 53) is checked before 60002 (line 86)**, so `/../../etc/passwd` is reported as *Command injection*, not *Path traversal* (confirmed in item 5 #6).
  A single `../` or `/etc/passwd` alone falls through to 60002.
- A threshold rule that has not reached its count does `continue` (`rules.py:86-87`). Failures 1-4 can therefore still be claimed by a later rule (e.g. 90001 if the line contains "pan").
  The history is appended before the count check (`:81`), so those lines still count toward 5710.

---

## C. Seal / Merkle / chain

### 7. Seal cadence — real behaviour

- Scheduler: **`@Cron(CronExpression.EVERY_MINUTE)`** → `sealBatch()` (`src/integrity/integrity.scheduler.ts:11-19`). A second every-minute cron runs `anchorSealedBatches → reanchorUnverified → verifyAllBatches` (`:21-33`).
  `ScheduleModule.forRoot()` is registered at `src/app.module.ts:93`. The cron fires at second :00. Local DB evidence: every `sealed_at` is `HH:MM:00.0xx`.
- Each tick seals **at most `BATCH_SIZE = 100`** unmapped logs, ordered `createdAt ASC, id ASC` (`src/integrity/integrity.service.ts:16, 81-85`). **There is no size-based flush.** 100 is a cap per tick, not a trigger.
  A backlog drains at 100 logs per minute (this matches the limitation already recorded in `docs/plan/todo.md:158`).
- **CRITICAL does not force a flush.** Nothing in ingest calls `sealBatch` (`src/logs/logs.service.ts:25-85`). The only other trigger is the manual `POST /logs/seal-now` (item 8).
- **An empty interval creates no batch and no tx.** It returns `null` before any insert (`integrity.service.ts:87-90`).
  Local DB: gaps between consecutive batches range from 59 s to 5 h 03 m, and every batch has `log_count ≥ 1`.
- Ticks are serialised inside the process by `sealQueue` (`:47, 68-73`). Tx sends are serialised by `sendQueue` (`src/blockchain/blockchain.service.ts:127, 355-358`).

**Real cadence: at most one batch (≤100 logs) and one `storeRoot` tx per minute, and only in minutes that have pending logs.**

Reconciling the evidence:
- *~1,161 FAILED from 2026-10-08 12:41 to 10-09 08:04 UTC*: that span is 19 h 23 m = 1,163 minutes, so one FAILED per cron tick.
  The code explains the loop. On FAILED, the mapping is **not** written (`integrity.service.ts:146-149`; compare `sealWithoutAnchor` 217-220, `confirmBatch` 297-300, `deferConfirmation` 319-322).
  The same pending logs are therefore picked again on the next tick (`:77-85`), and a **new** `batches` row is inserted each time before `storeRoot` (`:97-103`).
  A persistent pre-broadcast error (empty wallet, RPC down, estimateGas failure) produces exactly one FAILED row per minute until fixed. Each of those rows also calls Isolation Forest (`:107`).
- *Consecutive batches at 08:10 and 08:11*: normal behaviour. Either new logs arrived in each minute, or a backlog of more than 100 drained over two ticks.
- **UNKNOWN**: those 1,161 rows are **not in the local DB**. Locally there are 52 CONFIRMED + 2 FAILED, the FAILED from 2026-09-22 with no `tx_hash`. They are presumably on the cloud (CT141).
  To settle the cause: on the cloud DB, `SELECT count(*), count(tx_hash), min(log_count), max(log_count), min(sealed_at), max(sealed_at) FROM batches WHERE status='FAILED'`, plus the backend log lines `Batch … failed to commit` for that window.
  If `count(tx_hash)=0`, no gas was spent on them.

### 8. `POST /api/v1/logs/seal-now`

It exists, with **`@Roles('admin')`** only (`src/integrity/integrity.controller.ts:44-54`). It returns the batch, or `{ message: 'No pending logs to seal' }`. It goes through the same `sealQueue`.
`POST /logs/verify-now` is also admin-only (`:29-37`).

### 9. Merkle leaf and tree

- **Leaf input = `logs.raw_hash`** (`integrity.service.ts:93`), in the order `createdAt ASC, id ASC` at seal (`:83`) and at verify (`:550`, comment "ต้องตรงกับ sealBatch").
- `raw_hash` = `sha256(utf8(JSON.stringify({...})))` as lowercase hex (`src/logs/services/log-hash.ts:52-68`). The keys appear in exactly this order:
  `v` (=2), `id`, `source`, `sourceIp` (normalised, `null` if absent), `eventType`, `severity`, `message` (**masked**), `classification`, `cdeScope` (boolean), `createdAt` (`toISOString()`, ms precision, `Z`).
  The separator is JSON's own (no spaces). `retentionDays` is **not** in the hash.
  Verify also accepts legacy v1 = `sha256(JSON{source,eventType,message})` (`:75-103`).
- **Leaf hash = `sha256(utf8 text of the 64-char hex raw_hash)`.** `createHash('sha256').update(string)` hashes the hex *characters*, not the 32 decoded bytes (`src/integrity/service/merkle.service.ts:6-8, 24`).
  Any external verifier (snapshot diff, benchmark, Solidity) must reproduce this exactly.
- Tree: `merkletreejs` 0.6.0, `new MerkleTree(hashedLeaves, sha256, { sortPairs: true })` (`merkle.service.ts:25`).
  Internal node = `sha256(concat(sort([left, right], Buffer.compare)))`. **An odd last node is promoted unchanged** to the next layer (not duplicated), because `duplicateOdd` defaults to false
  (`node_modules/merkletreejs/dist/MerkleTree.js:41, 121-176`, odd branch at ~`:152`). The root is `getHexRoot()` with a `0x` prefix.
  It is stored without `0x` in `batches.merkle_root char(64)` (`integrity.service.ts:99`).
- A proof is a list of `{position, data}` steps, and `verifyProof` uses `sortPairs: true` (`merkle.service.ts:33-53`).

### 10. Reading the root back; contract; duplicates

- Contract key: `batchKey = keccak256(utf8(batch UUID string))` via `ethers.id` (`src/blockchain/blockchain.service.ts:266-268, 280`). Root = bytes32 (`:282-284`).
- Read-back: `getRoot(batchKey)` → `(bytes32 root, uint256 timestamp)` (`:406-412`). `checkRoot` returns MISSING if the root is all zeros, MATCH if it is equal case-insensitively, otherwise MISMATCH (`:422-444`).
  `verifyAllBatches` recomputes the root from the DB rows, compares it with the chain, and also re-checks every row's own `raw_hash` (`integrity.service.ts:373-448`).
- Config: `CONTRACT_ADDRESS` (env; `.env.example:29`; local `.env` = `0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5`), `BLOCKCHAIN_RPC_URL` (`.env.example:28`), validated at boot (`blockchain.service.ts:146-183`).
  The ABI is human-readable (`:14-19`). The private key comes from Vault `secret/logchain/blockchain` (`infra/vault/init.sh:53-54`).
- Duplicate batchId: **the contract reverts `"Root already exists"`** (`~/Documents/logchain-contracts/contracts/LogIntegrity.sol:32-37`; the repo has no `.sol`).
  The backend classifies this as `ROOT_EXISTS` (`blockchain.service.ts:89-100`) and calls `checkRoot`. MATCH → CONFIRMED with no new tx. Otherwise → FAILED (`integrity.service.ts:130-135, 336-367`).
  The anchor and re-anchor paths handle it too (`:261-273`, `:524-531`). `onlyOwner` reverts `"Not authorized"` (`.sol:20-23`).

### 11. Batch statuses

`status` is a free `varchar(16)` with no DB enum or check (`infra/postgres/init/02-schema.sql:32`, `src/logs/entities/batch.entity.ts:24-25`). The values are documented in `integrity.service.ts:18-33`:

| Status | Set by |
|---|---|
| `PENDING` | insert at seal (`integrity.service.ts:101`). Transient; it stays only if the process dies mid-seal |
| `SEALED` | chain not ready (`:111-112, 214`). TAMPERED→SEALED when a never-anchored batch is clean again (`:481-487`) |
| `UNVERIFIED` | tx sent but not confirmed in time (`:125-126, 316`; `blockchain.service.ts:303-323`). Late anchor not yet confirmed (`:253`). Chain says MISSING (`:421-430`) |
| `CONFIRMED` | receipt OK (`:287-294`). ROOT_EXISTS + MATCH (`:347-351`, `:264-266`). Late anchor confirmed (`:253-254`). Re-verified clean (`:433-439`) |
| `TAMPERED` | chain MISMATCH or any row ≠ its `raw_hash` (`:416-420`). Local root mismatch (`:465-470`) |
| `FAILED` | any other `storeRoot` error, or ROOT_EXISTS with a different root (`:146-149, 364-366`). Never re-verified: `verifyAllBatches` skips FAILED (`:374-381`) |

How consumers handle them:
- `stats.service.ts:18-24` `BATCH_STATUSES` = CONFIRMED, SEALED, UNVERIFIED, TAMPERED, PENDING. **FAILED is missing** from the per-status breakdown.
- `INTACT_STATUSES = ['CONFIRMED','SEALED']` (`batch.entity.ts:60`).
- Verify page tones: CONFIRMED good, TAMPERED danger, FAILED/PENDING warn, SEALED neutral. **UNVERIFIED falls to `default` → neutral** (`cylis-dashboard/src/views/Verify.tsx:19-31`).

### 12. Receipt / gas fields / fee cap

- The receipt **is** read: `tx.wait(1, txTimeoutMs)` (`blockchain.service.ts:292`). Only `receipt.hash` and `receipt.blockNumber` are used (`:295-302`).
- **`gas_used` and `effective_gas_price` are not stored anywhere.** There are no columns for them (`batch.entity.ts`, live `information_schema`), and grep over `src/` and `cylis-dashboard/src` finds them only in a spec mock (`blockchain.nonce.spec.ts:262-264`).
  A benchmark therefore needs a new migration (e.g. `batches.gas_used bigint`, `batches.effective_gas_price numeric`) or a read of the receipt by `tx_hash` from the RPC.
- Known figure from the worklog: **`gasUsed 78,156` per `storeRoot`** (`docs/worklog/2026-09-30.md:50`, `2026-09-29.md:83`). This is constant for any batch size, because the contract stores one bytes32 root + timestamp + event.
- Priority-fee cap: `BLOCKCHAIN_MAX_PRIORITY_FEE_GWEI` (`.env.example:36` = **50**; local `.env` = 50). Parsed at `blockchain.service.ts:230-234`. Empty or 0 means uncapped.
  Applied in `cappedFees()`: tip = min(RPC suggestion, cap), maxFee = suggestedMaxFee − suggestedTip + tip, and each tx logs `Priority fee: RPC suggested X gwei → using Y gwei` (`:366-386`).
  Rough cost: 78,156 × 50 gwei ≈ 0.0039 POL; at 30 gwei ≈ 0.0023 (`docs/runbooks/exam-commands.md:64`).
- Local `.env:64` has **`INTEGRITY_AUTO_REANCHOR=true`** (the `.env.example:110` default is false). Re-anchoring UNVERIFIED batches can send extra txs (`integrity.service.ts:497-537`).

### 13. Hardhat for a no-POL benchmark

- Not in this repo. The separate project is **`~/Documents/logchain-contracts`** (2 commits): Hardhat **3.8** + `hardhat-toolbox-viem`, Solidity 0.8.28 (`hardhat.config.ts:1-21`).
  It has **simulated in-process networks `hardhatMainnet` (edr-simulated, l1) and `hardhatOp`** (`:23-30`). These need no POL and no RPC. There are also `sepolia` / `polygonAmoy` http networks with `configVariable` keys (`:31-43`).
  Existing files: `contracts/LogIntegrity.sol`, `test/LogIntegrity.ts`, `scripts/deploy.ts`, and `ignition/` (chain-80002 deployment).
- A 1:1 vs 100:1 benchmark can run there: deploy `LogIntegrity`, then call `storeRoot` 100× (one per log) versus 1×, and read `gasUsed` from the receipts.
  `scripts/deploy-contract.mjs` in this repo targets a Hardhat **node** (JSON-RPC) and reads the artifact from `~/Documents/logchain-contracts/artifacts/...` (`scripts/deploy-contract.mjs:2-24`). `npx hardhat node` would provide one.
- **UNKNOWN**: whether `logchain-contracts` installs and compiles cleanly today. To settle it: `cd ~/Documents/logchain-contracts && npx hardhat test` (read-only to the repo, local only).

---

## D. DB & data model

### 14. Migrations (all registered in `src/app.module.ts:30-36, 67-75`; `migrationsRun: true` at `:76`; live `migrations` table has the same 7 rows)

| # | Timestamp | Class / file | What |
|---|---|---|---|
| 1 | 1790121600000 | `AlertsRuleDedup` | alerts `rule_id`, `occurrence_count`, `last_seen_at`; dedup index with rule_id |
| 2 | 1790208000000 | `AlertsLastNotified` | alerts `last_notified_at` |
| 3 | 1790294400000 | `KafkaPendingLogs` | `kafka_pending_logs` outbox table |
| 4 | 1790380800000 | `ErasureLog` | `erasure_log` + no-update trigger |
| 5 | 1790467200000 | `ErasurePseudonymize` | erasure_log `method`, `pseudonym` |
| 6 | 1790553600000 | `AlertsSourceLength` | alerts.source → varchar(128) |
| 7 | 1790640000000 | `BatchIsoForest` | batches `if_anomaly/if_score/if_reason/if_scored_at` |

The step is +86,400,000 each time, so the **next free number is `1790726400000`**. Any larger value works, but following the pattern keeps the order obvious.

### 15. `logs` table, trigger, retention, erasure

- Columns (live DB = `02-schema.sql:5-18`): `id uuid PK`, `source varchar(128)`, `source_id inet`, `event_type varchar(64)`, `severity varchar(16)`, `message text`, `raw_hash char(64)`,
  `classification varchar(16)`, `retention_days int`, `cde_scope bool`, **`batch_id uuid` (legacy, unused: 0 of 338 rows set, not in the entity)**, `created_at timestamptz`.
  Indexes: PK, `created_at DESC`, `source`, `severity`, `cde_scope` (`02-schema.sql:20-23`).
- Triggers (`infra/postgres/init/04-write-only-trigger.sql:2-16`; live: both enabled `O`): `trg_logs_no_update` BEFORE UPDATE and `trg_logs_no_delete` BEFORE DELETE, FOR EACH ROW.
  The function `prevent_log_mutation()` does `RAISE EXCEPTION 'IMMUTABLE_LOG: % not permitted on logs table'`.
  Only a superuser or the table owner can bypass it, with `ALTER TABLE logs DISABLE TRIGGER`. `scripts/demo-tamper.sh:19,89` and the integration tests (`test/integrity.integration.spec.ts:176,267`, `test/report-cases.integration.spec.ts:206`) do exactly that.
  The app connects as `logchain`, which owns the table and therefore *can* disable the trigger.
- **Retention never touches `logs`.** The `RetentionService` cron (daily at midnight) deletes only `alerts` (older than RETENTION_DAYS, default 365) and `audit_access` (≥365) (`src/retention/retention.service.ts:30-49`).
  `logs.retention_days` is stored (`logs.service.ts:64`) but only **reported**: counts of expired and expiring rows (`src/compliance/compliance.service.ts:150-154`). It is never enforced.
- **Erasure (PDPA) never touches `logs`.** `DELETE /api/v1/erasure/user/:userId` (admin, `src/erasure/erasure.controller.ts:14-24`) pseudonymises only `audit_access`, in one transaction:
  `user_id` → `anon-` + HMAC-SHA256 with the Vault key `secret/logchain/erasure`, `username` and `ip_address` → NULL, and references in `resource` are rewritten (`src/erasure/erasure.service.ts:55-119`).
  It writes a tombstone row in append-only `erasure_log` (`:94-108`; trigger in migration `1790380800000-ErasureLog.ts:31-45`). Nothing deletes or nulls a sealed log. There is no code path that does it.

### 16. `log_batch_mapping` and `batches`

- `log_batch_mapping`: `log_id uuid PK FK→logs(id)`, `batch_id uuid NOT NULL FK→batches(id)`, `mapped_at timestamptz` (`02-schema.sql:73-77`). Index `idx_mapping_batch(batch_id)` (`:79`). Entity: `src/logs/entities/log-batch-mapping.entity.ts`.
- `batches`: `id uuid PK`, `merkle_root char(64)`, `log_count int`, `tx_hash varchar(128)`, `block_number bigint`, `status varchar(16)`, `sealed_at`, `confirmed_at`, `if_anomaly`, `if_score`, `if_reason`, `if_scored_at`
  (`02-schema.sql:26-35` + `BatchIsoForest`). **The only index is the PK.** There is none on `status` or `sealed_at`, although `listBatches` orders by `sealed_at` and verify filters by status (`integrity.service.ts:374-381, 624-627`).
- A join of logs → mapping (by PK `log_id`) → batches (by PK `id`) for a page `ORDER BY l.created_at DESC LIMIT n` is cheap: every join key is a PK and the sort has `idx_logs_created_at`.
  The current plan is seq scans plus hash joins only because there are 338 rows (EXPLAIN run locally). A "status per log" column in `GET /logs` costs two PK lookups per row.

### 17. Alerts

- Columns (live DB): `id`, **`log_id uuid` (single, nullable, no FK, no index)**, `batch_id uuid`, `alert_type varchar(64)`, `severity varchar(16)`, `source varchar(128)`, `title text`, `detail jsonb`, `status varchar(16)`,
  `created_at`, `rule_id varchar(32)`, `occurrence_count int`, `last_seen_at`, `last_notified_at` (`src/alerts/entities/alert.entity.ts:22-66`).
  The unique partial index is `idx_alerts_open_dedup_rule (alert_type, source, COALESCE(batch_id), COALESCE(rule_id)) WHERE status='OPEN'`.
- Which `log_id` gets stored: detection sends the id of **the event currently being evaluated** (`detection/app/consumer.py:131`). The backend maps it to `logId` (`src/kafka/kafka-consumer.service.ts:241-247`).
  - 5710: the **5th failure** (the one that crosses the threshold). Failures 1-4 are not linked.
  - 5715: the **successful-login** log. The 5710 failures are not linked.
  - Any repeat while the alert is OPEN (same `alert_type`, `source`, `rule_id`) only bumps `occurrence_count`, `last_seen_at` and `severity` (`src/alerts/alerts.service.ts:44-55, 165-197`). **`log_id` stays the first trigger forever**, and the repeat log ids are dropped.
    Because the key is `source` and not the IP, a new brute force from another IP on the same VPS also folds into the old OPEN alert.
  - `source_ip` is sent by detection (`consumer.py:133`) but is **not persisted** by the backend (`kafka-consumer.service.ts:241-247`). It survives only inside `detail.ip_intel` when enrichment runs.
- **Smallest change for a full alert→logs link (proposal only):**
  1. Migration `1790726400000-AlertLogs`: `CREATE TABLE alert_logs (alert_id uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE, log_id uuid NOT NULL REFERENCES logs(id), role varchar(16) NOT NULL /* trigger|window|prior|repeat */, added_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (alert_id, log_id)); CREATE INDEX ON alert_logs(log_id);`
     Use `ON DELETE CASCADE`, because retention deletes alerts. **Do not** add the append-only trigger to this table, or retention breaks.
  2. Detection: change `_event_history` from timestamps to `(ts, log_id)` (`rules.py:38, 80-85`). Put the window's ids in the alert (`detail.related_log_ids`), and for 5715 add the ids of the 5710 that fired (`_prior_matches` would need to keep them).
  3. Backend: in `createOrDedup` insert the trigger and window ids. In `recordRepeat` insert the repeat's `logId` (`ON CONFLICT DO NOTHING`). Keep `alerts.log_id` as "first trigger" for backward compatibility.
  4. API: `GET /alerts/:id` (does not exist today) returning the alert plus its joined logs.

---

## E. API & frontend

### 18. `GET /api/v1/logs`, `GET /api/v1/alerts`

- `GET /logs` uses `@Roles('analyst','operator','admin')`. The only query parameter is **`limit`** (default 100, `ParseIntPipe`, capped at 1000) (`src/logs/logs.controller.ts:37-43`, `src/logs/logs.service.ts:91-96`).
  There are **no filters and no offset or cursor**, and the order is `createdAt DESC`.
  The response is a **bare JSON array of `Log` entities**: `id, source, sourceIp, eventType, severity, message, rawHash, classification, retentionDays, cdeScope, createdAt`. It carries no batch or status info.
- `GET /logs/:id` (same roles) → `findOneBy`. An unknown id returns **200 with an empty body**, not 404 (`logs.controller.ts:45-50`, `logs.service.ts:87-89`). The id is not UUID-validated, so a non-UUID → 500.
- `GET /alerts` (`analyst`, `operator`, `admin`) returns **every alert**, unpaginated, ordered by `lastSeenAt DESC` (`src/alerts/alerts.controller.ts:40-45`, `alerts.service.ts:225-228`).
  `POST /alerts` is admin-only (`:31-38`). `PATCH /alerts/:id/resolve` takes operator or admin (`:48-62`). **There is no `GET /alerts/:id`.**

### 19. Integrity / verify endpoints

| Endpoint | Roles | Returns | Ref |
|---|---|---|---|
| `GET /logs/:id/proof` | analyst, operator, admin (**not auditor**) | `{ logId, rawHash, batch:{id, merkleRoot, txHash, blockNumber, status}, proof:[{position,data}], verify:boolean }`. 400 for a non-UUID, 404 if not sealed | `integrity.controller.ts:56-98`; service `integrity.service.ts:649-667` |
| `GET /batches?limit=` | analyst, operator, auditor, admin | latest batches (limit 1-100, default 10): `id, merkleRoot, txHash, blockNumber, status, logCount, sealedAt, confirmedAt, if*` | `src/integrity/batches.controller.ts:14-25`, `dto/list-batches.dto.ts:10-12`, `integrity.service.ts:623-644` |
| `POST /logs/verify-now` | admin | `{ ok, verifiedAt }`. Re-anchor + verify all | `integrity.controller.ts:29-37` |
| `POST /logs/seal-now` | admin | batch or message | `integrity.controller.ts:44-54` |
| `GET /stats/overview` | analyst, operator, admin | includes `batches.byStatus` (no FAILED) | `src/stats/stats.controller.ts:22-23` |

**Important:** the proof's `verify` checks the leaf against the **DB** `merkle_root`, not the chain (`integrity.service.ts:660-664`). It also does not recompute `raw_hash` from the row fields.
**No endpoint returns the on-chain root** or verifies a single batch on demand. The on-chain comparison happens only inside the cron (`integrity.service.ts:403-414`).
The untracked `scripts/verify-log-onchain.sh` does the full row → raw_hash → root → `getRoot` check from the shell (`:1-7`).

### 20. Frontend (cylis-dashboard)

- **Logs page** (`src/views/Logs.tsx`): calls `api.get("/logs")` with **no limit, so it gets the latest 100** (`:30-35`), although the comment claims "full set" (`:58-63`). Search, type and severity filtering and paging (10 per page) all run **client-side** (`:10, 64-78`).
  Filter state is mirrored into the query string `q, type, sev, page` (`:37-47`).
  Columns: **ID (truncated, click-to-copy full UUID), Timestamp, Source, IP, Event (message), Attack Type (= eventType), Severity** (`src/components/LogTable.tsx:87`, `:47-75`; mapping `src/lib/logRows.ts:24-37`).
  **There is no row detail view or drawer.**
- **Alerts page** (`src/views/Alerts.tsx`): columns `[expand], Severity, Type, Title, Source, Last seen (+×count), Status, [Resolve]` (`:185`).
  Clicking the chevron expands an inline row with `alert id · batch · log <uuid> · fired N×` and the raw `detail` JSON (`:196-201, 240-255`). **The log id is plain text, not a link.**
  `Resolve` is shown for every OPEN alert regardless of role (`:226-236`; the backend refuses analyst with 403).
- **Reusable proof/verify logic:** `src/views/Verify.tsx`. `runVerify(rawId)` → `GET /logs/${id}/proof` with 400/404/403 messages (`:90-122`). `verifyFromList(id)` (`:124`).
  `statusTone()` (`:19-31`), the proof-path render (`:245-260`), and the batch list from `GET /batches?limit=8` (`:66-73, 279`).
  Note that the copy at `:174` says it verifies "against the batch root committed on-chain", which is not what the endpoint does (item 19).

### 21. Role gating

- `src/lib/roles.ts`: `PAGE_ROLES` maps page → roles (`:12-21`: dashboard/logs/ml/dataset/verify/alerts = admin, analyst, operator; reports = admin, auditor; settings = admin).
  `currentRoles()` reads the token's `roles`, falling back to `realm_access.roles` (`:29-35`). `canAccessPage()` (`:37-42`).
- `src/App.tsx`: the menu is `NAV_ITEMS.filter(canAccessPage)` (`:32-41, 58`). **There is no URL routing.** It is one Next page (`src/app/page.tsx:1-5`) with `activeId` in React state (`:62`).
  The "route guard" is an effect that bounces to the first allowed page when the current one is no longer allowed (`:71-75`). The rendered page is picked from `visibleNavItems` only (`:97`).
  Login is `keycloak.init({ onLoad: 'login-required' })` (`src/lib/keycloak.ts:57`).
- The backend is the real enforcement (`@Roles` on every handler).

---

## F. Docs consistency (item 7 says: every minute, ≤100 logs per tick, no tx on empty minutes)

The grep covered every `*.md` (excluding node_modules) for 30 s / 30 วินาที / 60 วินาที / 30 นาที / 1 นาที / ทุกนาที / every minute near seal, batch, cron or anchor, plus `20,000` / `20000`.

| File:line | Text (short) | vs item 7 |
|---|---|---|
| `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:17` | "แก้รอบการ seal ในเอกสารเป็น**ทุก 30 นาทีตามโค้ดจริง**" | **Contradicts.** The code is every 1 minute |
| `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:111` | "ขึ้นเชนเมื่อไร … ไม่เกินรอบ seal **30 นาที**" | **Contradicts** |
| `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:152` | "seal บ่อยแค่ไหน \| **ทุก 30 นาที** และ … seal-now" | **Contradicts** (seal-now part correct) |
| `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:171` | "ในเล่มยังมีตัวเลข **"20,000 เท่า"** และรอบ seal **"60 วินาที"**" | Reports that the book says 60 s. **60 s = 1 min, so the book's cadence actually matches the code.** This line wrongly calls it a mismatch. "20,000×" is the real error (see :97) |
| `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:97` | "รวม 100 ล็อกเป็น 1 ธุรกรรมลด gas ได้ 100 เท่า … "20,000 เท่า" … ไม่ถูกต้อง" | Consistent with the code. Strictly it is ~100× in tx count, and slightly less in gas, because each tx also pays the 21,000 base |
| `docs/worklog/2026-09-17.md:105` | "cron seal/verify เดินทุกนาทีจริง" | OK |
| `docs/worklog/2026-09-17.md:114`, `2026-09-19.md:11,63-64` | old controller comment "30 นาที" → fixed to "1 นาที" | Historical. The code comment is now correct (`integrity.controller.ts:41`) |
| `docs/worklog/2026-09-19.md:73,83` | "cron seal ทุก 1 นาที" / "cron verify (ทุก 1 นาที)" | OK |
| `docs/worklog/2026-10-06.md:30,207` | "cron seal ทุก 1 นาที" / "ทุกนาทีที่วินาที :00 … แย่สุดราว 60 วิ" | OK |
| `docs/plan/isolation-forest-option.md:49` | "ปิดทุกนาทีหรือครบ 100 log" | **Slightly wrong.** There is no "when 100 is reached" flush; 100 is only the per-tick cap |
| `docs/plan/todo.md:158` | "ปิด batch ได้ 100 log/นาที" | OK |
| `docs/plan/onboarding-and-repo-consolidation.md:503` | "รอ cron seal 1 นาที" | OK |
| `docs/ISO27001-ISMS.md:107` | "Blockchain hash verification \| ทุก 1 นาที" | OK (verify cron) |
| `README.md:159, 178, 291, 332` | "รอ ~1 นาที" / "รอ 1 นาทีให้ปิด batch" / "ภายใน 1 นาที" | OK |
| `docs/runbooks/demo-cloud.md:35,39,41`, `docs/runbooks/exam-commands.md:48,108,116` | verify / anchor "ทุก 1 นาที", "≤ 1 นาที" | OK |
| `README.md:498`, `docs/worklog/2026-09-23.md:582` | "BatchStuckUnverified (เกิน 30 นาที)" | Not a seal interval (alert threshold 1800 s). OK |

`20,000` / `20000` appears in no other tracked or untracked text file in the repo. The book itself (`~/Documents/final_volume/*.docx`) is outside the repo and was not grepped. **UNKNOWN** where in the book it appears; settle it with a search in Word.

---

## G. Budget (cadence from item 7; 0.0039 POL/tx = 78,156 gas × 50 gwei; forwarder cap 300 logs/h; wallet 0.159 POL)

Facts that drive the cost:
- At most **1 tx per minute**, and only in minutes with pending logs. **An empty minute costs nothing** (no batch, no tx; `integrity.service.ts:87-90`).
- The verify cron uses `getRoot` (`eth_call`), which is free.
- A FAILED batch from a pre-broadcast error costs no gas. A broadcast that reverts on chain (CALL_EXCEPTION) does cost gas, and then repeats every minute.
- Gas per tx does not depend on log count (one root). 1–100 logs cost the same.

**Case 1: steady trickle (300 logs/h ≈ 5 logs/min, spread out). This is the realistic VPS case.**
- Assuming arrivals are random at λ = 5/min, P(empty minute) = e^-5 ≈ 0.7%, so practically every minute seals.
- tx/day ≈ 60 × 24 = **1,440** (×0.993 ≈ 1,430).
- POL/day ≈ 1,440 × 0.0039 = **5.62 POL/day**.
- 0.159 POL lasts 0.159 / 0.0039 ≈ **40.8 tx ≈ 41 minutes**. At 30 gwei (0.0023): 69 tx ≈ 69 min.
- Logs per batch ≈ 5, so batching saves ~5× here, not 100×.

**Case 2: best case, logs in bursts of ≥100.**
- tx/h = ceil(300/100) = 3, so tx/day = **72**.
- POL/day = 72 × 0.0039 = **0.281**.
- 0.159 / 0.281 = **0.57 days ≈ 13.6 h**.

**Case 3: what the plan's "every 30 minutes" would mean, if the code were changed.**
- 48 ticks/day, but `BATCH_SIZE = 100` still caps each tick. 300 logs/h = 150 logs per tick, yet only 100 get sealed, so **the backlog grows by 100 logs/h without bound**.
- To keep up, either loop until no pending logs remain or raise `BATCH_SIZE` to ≥150. That gives 48 tx/day = 0.187 POL/day, and 0.159 lasts ≈ 0.85 days ≈ 20 h.
- For 0.159 POL to last 30 days you need ≤ 0.159 / 0.0039 / 30 ≈ **1.36 tx/day**, i.e. about one seal every ~18 h.

Conclusion: with the code as it is, 0.159 POL funds the VPS forwarder for **under an hour**. The demo needs either a longer seal interval with a bigger or looped batch, a forwarder throttle, or more POL.

---

## Surprises / risks

1. **The plan's seal interval is wrong.** `docs/LogChain-แผนแก้ไขตามคอมเมนต์กรรมการ.md:17,111,152` says "30 minutes, as in the real code". The code is **every 1 minute** (`integrity.scheduler.ts:12`).
   The book's "60 วินาที" is correct, so line 171 misdiagnoses it. If the team *changes* the cron to 30 min, it must also raise or loop `BATCH_SIZE`, or 300 logs/h backs up (item G case 3).
2. **The real sshd lines trigger nothing.** 5710 and 5715 regexes do not match `Failed password`, `Invalid user` or `Accepted publickey|password` (item 5). The "real logs from a VPS" demo shows **zero auth alerts** unless the rules YAML changes.
   That YAML change touches the 416-case test lock; see memory/next-steps on the freeze. `zgrab` and `/.env` probes also go undetected.
3. **The rules group by `source`, not `sourceIp`.** One forwarder `source` means all attackers share the 5710 counter, and alert dedup is also per `source`. One OPEN 5710 alert swallows every later brute force from any IP until someone resolves it.
   Per-IP grouping needs either one `source` per IP on the forwarder (bad) or an engine change to key on `sourceIp`.
4. **Masking changes the message IP** (`.xxx`). Per-IP correlation must come from the `sourceIp` field, so the forwarder must parse it out of each line. Usernames are not masked.
   `sourceIp` is stored, published and alerted in full. Check that the PDPA story in the book matches this.
5. **90001 false positives:** the regex `pan` matches "company", "panel", "expand", "Japan", and the `[PAN]` mask token itself. Real nginx and sshd traffic will raise CRITICAL "Card data access" alerts and email.
6. **First-match ordering** reports `../../` as 31151 (command injection) instead of 60002. URL-encoded SQLi (`%20UNION%20SELECT`) bypasses 31100 and is caught only by the sqlmap UA.
7. **The alert→log link is lossy today.** `log_id` holds the 5th failure, or the success log for 5715. Repeats never update it, and `source_ip` is dropped by the backend.
   A join table is needed (item 17), and it must **not** be append-only, because retention deletes alerts.
8. **The tamper-diff prompt** (`docs/logchain-tamper-diff-prompt.md`) **makes wrong assumptions:**
   - (a) It assumes "the same transaction that writes `log_batch_mapping`". Sealing uses **no DB transaction**: the batch insert, IF scoring, chain tx and mapping insert are separate statements (`integrity.service.ts:97-128, 214-220, 292-300`). One would have to be added.
   - (b) It says to "add `GET /api/v1/integrity/batches` if missing". **`GET /api/v1/batches` already exists** (item 19).
   - (c) It says "Erasing a sealed log will legitimately show up as DELETED". **No erasure or retention path touches `logs`** (item 15), so there is no conflict with a write-only snapshot table today.
     The flip side: PDPA erasure of log content is not implemented at all. If it ever is, both `logs` and the snapshot will need the same trigger-bypass design.
   - (d) Snapshots must store the exact hash inputs, `createdAt` as an ms-precision ISO string, and the **masked** message. The rebuilt leaf must hash the **hex text** of `raw_hash`, with sorted pairs and odd-node promotion (item 9).
   - (e) FAILED batches have no mapping. Their logs are re-sealed into later batches, so a log can appear in many FAILED `batches` rows. Snapshot only on the path that writes the mapping.
9. **The "on-chain status per log" UI would mislead if it were built on `/logs/:id/proof`**, because that compares with the DB root. The Verify page copy already over-claims ("committed on-chain", `Verify.tsx:174`).
   Per-log on-chain status should be derived from `batches.status` (set by the cron's chain check) or from a new endpoint that calls `getRoot`.
10. **Status handling is inconsistent.** Stats omit FAILED (`stats.service.ts:18-24`), and the Verify page shows UNVERIFIED as neutral (`Verify.tsx:30`).
    A FAILED-retry storm (the 1,161 rows) is invisible on the dashboard breakdown. `batches` has no index on `status` or `sealed_at`, and verify scans all non-FAILED batches every minute with one RPC call each.
11. **No gas data is persisted**, so the 1:1 vs 100:1 benchmark needs a migration or post-hoc receipt reads.
    The local Hardhat simulation lives in the separate `logchain-contracts` repo (Hardhat 3, edr-simulated). Gas per `storeRoot` is constant (~78k), so the expected ratio is ≈100× in tx count and somewhat less in gas.
12. **Local `.env` has `INTEGRITY_AUTO_REANCHOR=true`.** UNVERIFIED batches can trigger extra paid txs; budget for them.
13. **Environment:** backend and detection-consumer are **Exited (137)** and Vault is restarting. This looks like the "Docker upgrade seals Vault" pattern. Nothing was touched; unseal and `compose up` before any live check.
