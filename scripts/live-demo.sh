#!/usr/bin/env bash
#
# live-demo.sh — สาธิตการแก้ไขข้อมูลสดบน LogChain แล้ว restore คืน (สำหรับนำเสนอ)
#
#   ./live-demo.sh status            สถานะทุกเคส + Chain integrity + alert OPEN
#   ./live-demo.sh <case>            ยิงเคส (content|rehash|hash|move|snapshot|dbroot)
#   ./live-demo.sh restore <case>    คืนค่าเคสนั้นจาก backup
#   ./live-demo.sh restore-all       คืนทุกเคสที่ยังค้างอยู่
#
# ความปลอดภัย (ดู docs/runbooks/live-demo.md):
#  - ยิงได้เฉพาะ batch ที่ CONFIRMED และยังไม่ถูกยิงค้าง (มี backup row = ปฏิเสธ)
#  - backup ลงตาราง _live_demo_backup · restore จาก backup + เช็ค IS NOT DISTINCT FROM แล้วลบ backup
#  - ทุกการแก้เป็น transaction เดียว + guard จำนวนแถว · DDL transactional → rollback คืน trigger เอง
#  - trigger คืนเป็น ALWAYS (logs) / O (snapshot) เสมอ · ไม่แตะ batch/log อื่น
#  - ไม่เรียก seal · ไม่เขียนเชน · ไม่แก้ .env · ไม่มีเคสลบ log จริง · ไม่มีเคส UNVERIFIED
#
set -euo pipefail

# ── config: batch CONFIRMED เล็ก ๆ คนละใบต่อเคส (ห้ามซ้ำ) ─────────────────
PSQL_CONTAINER="${PSQL_CONTAINER:-logchain-postgres}"
ENV_FILE="${ENV_FILE:-$HOME/logchain/.env}"
DEMO_MSG="LIVE-DEMO tampered message"

declare -A BATCH=(
  [content]="1d433a5d-52b1-4c3e-9420-211004614088"
  [rehash]="62670476-f728-405f-a420-c59731b0aaa1"
  [hash]="7ef113f5-aae9-4a98-bd7d-138f958b2c55"
  [snapshot]="e78d43b9-46d7-46a6-8162-449abb8be7ee"
  [dbroot]="aabad945-2ea1-4acc-9bd3-4a081a37fc26"
  [move]="afbc538a-cb71-4502-ad80-39dd236e0495"
)
MOVE_DEST="a6b87a02-82c6-4799-b6c8-f014c5c9eeb5"
CASES=(content rehash hash move snapshot dbroot)

# override config ได้ (เช่นทดสอบบน hh): LIVE_DEMO_CONF=<file> ที่ redefine BATCH/MOVE_DEST/PSQL_CONTAINER
if [ -n "${LIVE_DEMO_CONF:-}" ] && [ -r "${LIVE_DEMO_CONF}" ]; then source "${LIVE_DEMO_CONF}"; fi

declare -A DESC=(
  [content]="แก้ message อย่างเดียว (ไม่แตะ raw_hash)"
  [rehash]="แก้ message + raw_hash ให้ตรงกัน (จำลองผู้โจมตีรู้สูตร)"
  [hash]="แก้คอลัมน์ raw_hash อย่างเดียว (เนื้อหาเดิม)"
  [move]="ย้าย mapping ของ log ไป batch อื่น (ไม่ลบ mapping)"
  [snapshot]="แก้ทั้ง log และ batch_log_snapshot"
  [dbroot]="แก้ batches.merkle_root (คง 64-hex)"
)
# ช่องที่ควรแดงบนหน้า Check ของแต่ละเคส
declare -A REDS=(
  [content]="contentRoot (proof: CONTENT_MODIFIED)"
  [rehash]="storedHashRoot + contentRoot (เทียบ chain = MISMATCH)"
  [hash]="storedHashRoot (proof: HASH_MODIFIED, verify ยัง true)"
  [move]="ต้นทาง: DELETED/MAPPING_MISSING · ปลายทาง: UNMAPPED_OR_INSERTED"
  [snapshot]="contentRoot + snapshotTrusted=false (SNAPSHOT_CONTENT_MISMATCH)"
  [dbroot]="dbRoot (status ไม่พลิก — verify ยึด chain)"
)

# ── psql helpers (รันในคอนเทนเนอร์ postgres) ─────────────────────────────
runsql()  { docker exec -i "$PSQL_CONTAINER" psql -U logchain -d logchain -v ON_ERROR_STOP=1 "$@"; }
scalar()  { docker exec -i "$PSQL_CONTAINER" psql -U logchain -d logchain -tAc "$1"; }

ensure_backup_table() {
  runsql -q <<'SQL'
CREATE TABLE IF NOT EXISTS _live_demo_backup (
  case_name       text PRIMARY KEY,
  batch_id        uuid,
  dest_batch_id   uuid,
  log_id          uuid,
  orig_message    text,
  orig_raw_hash   text,
  orig_merkle_root text,
  orig_snapshot   jsonb,
  fired_at        timestamptz NOT NULL DEFAULT now()
);
SQL
}

dashboard_url() {
  local u=""
  [ -r "$ENV_FILE" ] && u="$(grep -E '^DASHBOARD_PUBLIC_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
  echo "${u:-<ตั้ง DASHBOARD_PUBLIC_URL ใน .env>}"
}

is_fired()      { [ "$(scalar "SELECT EXISTS(SELECT 1 FROM _live_demo_backup WHERE case_name='$1')")" = t ]; }
batch_status()  { scalar "SELECT COALESCE((SELECT status FROM batches WHERE id='$1'),'(missing)')"; }

# log แรกของ batch (ตามลำดับ leaf: created_at ASC, id ASC)
first_log() { scalar "SELECT l.id FROM logs l JOIN log_batch_mapping m ON m.log_id=l.id WHERE m.batch_id='$1' ORDER BY l.created_at, l.id LIMIT 1"; }

die() { echo "✗ $*" >&2; exit 1; }

require_confirmed_unfired() {
  local case="$1" b="$2"
  [ "$(batch_status "$b")" = CONFIRMED ] || die "เคส $case: batch ${b:0:8} ไม่ใช่ CONFIRMED (เป็น $(batch_status "$b")) — ไม่ยิง"
  is_fired "$case" && die "เคส $case: ถูกยิงค้างอยู่แล้ว (มี backup) — restore ก่อน"
  return 0
}

print_check_hint() {
  local case="$1" b="$2" logid="$3"
  local url; url="$(dashboard_url)"
  echo
  echo "  ── ตรวจบนหน้า Check ──"
  echo "  Dashboard : $url  (เปิดหน้า Verify)"
  echo "  batch     : $b"
  [ -n "$logid" ] && echo "  log id    : $logid  (วางในช่อง Verify)"
  [ "$case" = move ] && echo "  batch ปลายทาง: $MOVE_DEST"
  echo "  ควรแดง    : ${REDS[$case]}"
  if [ "$case" = dbroot ]; then
    echo "  → เปิดหน้า Check เห็น dbRoot แดงทันที · status จะ 'ไม่' พลิก (verify ยึด chain)"
  else
    echo "  → เปิดหน้า Check/กด Verify เห็นแดงทันที · status badge พลิก TAMPERED ภายใน ≤1 นาที (verify cron)"
  fi
}

# ───────────────────────── FIRE ─────────────────────────
fire() {
  local case="$1"
  [ -n "${BATCH[$case]:-}" ] || die "ไม่รู้จักเคส: $case (มี: ${CASES[*]})"
  ensure_backup_table
  local b="${BATCH[$case]}"

  case "$case" in
    content|rehash|hash|snapshot) require_confirmed_unfired "$case" "$b" ;;
    dbroot)                        require_confirmed_unfired "$case" "$b" ;;
    move)
      require_confirmed_unfired move "$b"
      [ "$(batch_status "$MOVE_DEST")" = CONFIRMED ] || die "move: batch ปลายทาง ${MOVE_DEST:0:8} ไม่ใช่ CONFIRMED"
      ;;
  esac

  local logid=""
  case "$case" in content|rehash|hash|snapshot|move) logid="$(first_log "$b")"; [ -n "$logid" ] || die "เคส $case: batch ไม่มี log" ;; esac

  echo "▶ ยิงเคส $case — ${DESC[$case]}"

  case "$case" in
  content)
    runsql -v msg="$DEMO_MSG" -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,log_id,orig_message,orig_raw_hash)
  SELECT 'content','$b','$logid', message, raw_hash FROM logs WHERE id='$logid';
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
WITH u AS (UPDATE logs SET message=:'msg' WHERE id='$logid' RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  COMMIT;
  \\echo '  ✓ content: message เปลี่ยนแล้ว'
\\else
  ROLLBACK;
  \\echo '  ✗ content: UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  rehash)
    runsql -v msg="$DEMO_MSG" -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,log_id,orig_message,orig_raw_hash)
  SELECT 'rehash','$b','$logid', message, raw_hash FROM logs WHERE id='$logid';
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
WITH u AS (
  UPDATE logs SET message=:'msg',
    raw_hash = encode(digest(
        '{"v":2,"id":'   || to_json(id::text)::text
      || ',"source":'    || to_json(source)::text
      || ',"sourceIp":'  || CASE WHEN source_id IS NULL THEN 'null' ELSE to_json(host(source_id))::text END
      || ',"eventType":' || to_json(event_type)::text
      || ',"severity":'  || to_json(severity)::text
      || ',"message":'   || to_json(:'msg'::text)::text
      || ',"classification":' || to_json(classification)::text
      || ',"cdeScope":'  || CASE WHEN cde_scope THEN 'true' ELSE 'false' END
      || ',"createdAt":' || to_json(to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
      || '}', 'sha256'), 'hex')
  WHERE id='$logid' RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  COMMIT;
  \\echo '  ✓ rehash: message + raw_hash (สอดคล้อง) เปลี่ยนแล้ว'
\\else
  ROLLBACK;
  \\echo '  ✗ rehash: UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  hash)
    runsql -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,log_id,orig_message,orig_raw_hash)
  SELECT 'hash','$b','$logid', message, raw_hash FROM logs WHERE id='$logid';
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
WITH u AS (UPDATE logs SET raw_hash=repeat('f',64) WHERE id='$logid' RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  COMMIT;
  \\echo '  ✓ hash: คอลัมน์ raw_hash เปลี่ยนแล้ว (เนื้อหาเดิม)'
\\else
  ROLLBACK;
  \\echo '  ✗ hash: UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  move)
    runsql -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,dest_batch_id,log_id)
  VALUES ('move','$b','$MOVE_DEST','$logid');
WITH u AS (UPDATE log_batch_mapping SET batch_id='$MOVE_DEST'
             WHERE log_id='$logid' AND batch_id='$b' RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  COMMIT;
  \\echo '  ✓ move: ย้าย mapping ไป batch ปลายทางแล้ว'
\\else
  ROLLBACK;
  \\echo '  ✗ move: UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  snapshot)
    runsql -v msg="$DEMO_MSG" -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,log_id,orig_message,orig_raw_hash,orig_snapshot)
  SELECT 'snapshot','$b','$logid', l.message, l.raw_hash, s.snapshot
    FROM logs l JOIN batch_log_snapshot s ON s.log_id=l.id AND s.batch_id='$b'
   WHERE l.id='$logid';
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
ALTER TABLE batch_log_snapshot DISABLE TRIGGER trg_snapshot_no_update;
WITH u AS (UPDATE logs SET message=:'msg' WHERE id='$logid' RETURNING 1)
  SELECT (count(*)=1) AS ok1 FROM u \\gset
WITH u2 AS (UPDATE batch_log_snapshot SET snapshot=jsonb_set(snapshot,'{message}',to_jsonb(:'msg'::text))
              WHERE batch_id='$b' AND log_id='$logid' RETURNING 1)
  SELECT (count(*)=1) AS ok2 FROM u2 \\gset
\\if :ok1
\\if :ok2
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  ALTER TABLE batch_log_snapshot ENABLE TRIGGER trg_snapshot_no_update;
  COMMIT;
  \\echo '  ✓ snapshot: log + snapshot เปลี่ยนแล้ว'
\\else
  ROLLBACK;
  \\echo '  ✗ snapshot: snapshot UPDATE != 1 — rolled back'
\\endif
\\else
  ROLLBACK;
  \\echo '  ✗ snapshot: log UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  dbroot)
    runsql -f - <<SQL
BEGIN;
INSERT INTO _live_demo_backup(case_name,batch_id,orig_merkle_root)
  SELECT 'dbroot','$b', merkle_root FROM batches WHERE id='$b';
WITH u AS (UPDATE batches
             SET merkle_root = overlay(merkle_root placing
                   (CASE WHEN left(merkle_root,2)='ff' THEN '00' ELSE 'ff' END) from 1 for 2)
             WHERE id='$b' RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  COMMIT;
  \\echo '  ✓ dbroot: merkle_root เปลี่ยนแล้ว (ยัง 64-hex)'
\\else
  ROLLBACK;
  \\echo '  ✗ dbroot: UPDATE != 1 — rolled back'
\\endif
SQL
    ;;
  esac

  is_fired "$case" || die "เคส $case: ยิงไม่สำเร็จ (ไม่มี backup) — ตรวจ output ด้านบน"
  print_check_hint "$case" "$b" "$logid"
}

# ─────────────────────── RESTORE ───────────────────────
restore_one() {
  local case="$1"
  ensure_backup_table
  is_fired "$case" || { echo "• $case: ไม่มี backup (ไม่ได้ยิงค้าง) — ข้าม"; return 0; }
  local b; b="$(scalar "SELECT batch_id FROM _live_demo_backup WHERE case_name='$case'")"
  echo "◀ restore เคส $case"

  case "$case" in
  content|rehash)
    runsql -f - <<SQL
BEGIN;
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
WITH b AS (SELECT log_id,orig_message,orig_raw_hash FROM _live_demo_backup WHERE case_name='$case'),
u AS (UPDATE logs l SET message=b.orig_message, raw_hash=b.orig_raw_hash FROM b WHERE l.id=b.log_id RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  COMMIT;
\\else
  ROLLBACK;
  \\echo '  ✗ restore $case: UPDATE != 1 — rolled back'
\\endif
SQL
    verify_delete "$case" "SELECT (l.message IS NOT DISTINCT FROM b.orig_message AND l.raw_hash IS NOT DISTINCT FROM b.orig_raw_hash) FROM logs l JOIN _live_demo_backup b ON b.log_id=l.id WHERE b.case_name='$case'"
    ;;
  hash)
    runsql -f - <<SQL
BEGIN;
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
WITH b AS (SELECT log_id,orig_raw_hash FROM _live_demo_backup WHERE case_name='hash'),
u AS (UPDATE logs l SET raw_hash=b.orig_raw_hash FROM b WHERE l.id=b.log_id RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  COMMIT;
\\else
  ROLLBACK;
  \\echo '  ✗ restore hash: UPDATE != 1 — rolled back'
\\endif
SQL
    verify_delete hash "SELECT (l.raw_hash IS NOT DISTINCT FROM b.orig_raw_hash) FROM logs l JOIN _live_demo_backup b ON b.log_id=l.id WHERE b.case_name='hash'"
    ;;
  move)
    runsql -f - <<SQL
BEGIN;
WITH b AS (SELECT log_id,batch_id,dest_batch_id FROM _live_demo_backup WHERE case_name='move'),
u AS (UPDATE log_batch_mapping m SET batch_id=b.batch_id FROM b
        WHERE m.log_id=b.log_id AND m.batch_id=b.dest_batch_id RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  COMMIT;
\\else
  ROLLBACK;
  \\echo '  ✗ restore move: UPDATE != 1'
\\endif
SQL
    verify_delete move "SELECT (m.batch_id IS NOT DISTINCT FROM b.batch_id) FROM log_batch_mapping m JOIN _live_demo_backup b ON b.log_id=m.log_id WHERE b.case_name='move'"
    ;;
  snapshot)
    runsql -f - <<SQL
BEGIN;
ALTER TABLE logs DISABLE TRIGGER trg_logs_no_update;
ALTER TABLE batch_log_snapshot DISABLE TRIGGER trg_snapshot_no_update;
WITH b AS (SELECT log_id,batch_id,orig_message,orig_raw_hash,orig_snapshot FROM _live_demo_backup WHERE case_name='snapshot'),
u AS (UPDATE logs l SET message=b.orig_message, raw_hash=b.orig_raw_hash FROM b WHERE l.id=b.log_id RETURNING 1)
  SELECT (count(*)=1) AS ok1 FROM u \\gset
WITH b AS (SELECT log_id,batch_id,orig_snapshot FROM _live_demo_backup WHERE case_name='snapshot'),
u2 AS (UPDATE batch_log_snapshot s SET snapshot=b.orig_snapshot FROM b
         WHERE s.log_id=b.log_id AND s.batch_id=b.batch_id RETURNING 1)
  SELECT (count(*)=1) AS ok2 FROM u2 \\gset
\\if :ok1
\\if :ok2
  ALTER TABLE logs ENABLE ALWAYS TRIGGER trg_logs_no_update;
  ALTER TABLE batch_log_snapshot ENABLE TRIGGER trg_snapshot_no_update;
  COMMIT;
\\else ROLLBACK; \\echo '  ✗ restore snapshot: snap UPDATE != 1'; \\endif
\\else ROLLBACK; \\echo '  ✗ restore snapshot: log UPDATE != 1'; \\endif
SQL
    verify_delete snapshot "SELECT (l.message IS NOT DISTINCT FROM b.orig_message AND l.raw_hash IS NOT DISTINCT FROM b.orig_raw_hash AND s.snapshot IS NOT DISTINCT FROM b.orig_snapshot) FROM _live_demo_backup b JOIN logs l ON l.id=b.log_id JOIN batch_log_snapshot s ON s.log_id=b.log_id AND s.batch_id=b.batch_id WHERE b.case_name='snapshot'"
    ;;
  dbroot)
    runsql -f - <<SQL
BEGIN;
WITH b AS (SELECT batch_id,orig_merkle_root FROM _live_demo_backup WHERE case_name='dbroot'),
u AS (UPDATE batches bt SET merkle_root=b.orig_merkle_root FROM b WHERE bt.id=b.batch_id RETURNING 1)
  SELECT (count(*)=1) AS ok FROM u \\gset
\\if :ok
  COMMIT;
\\else
  ROLLBACK;
  \\echo '  ✗ restore dbroot: UPDATE != 1'
\\endif
SQL
    verify_delete dbroot "SELECT (bt.merkle_root IS NOT DISTINCT FROM b.orig_merkle_root) FROM batches bt JOIN _live_demo_backup b ON b.batch_id=bt.id WHERE b.case_name='dbroot'"
    ;;
  *) die "ไม่รู้จักเคส: $case" ;;
  esac
}

# เช็คว่า restore ตรง backup (IS NOT DISTINCT FROM) แล้วลบ backup row ของเคสนั้น
verify_delete() {
  local case="$1" check_sql="$2" good
  good="$(scalar "$check_sql")"
  if [ "$good" = t ]; then
    runsql -q -c "DELETE FROM _live_demo_backup WHERE case_name='$case'"
    echo "  ✓ restore $case สำเร็จ + ตรงกับ backup → ลบ backup แล้ว (รอ verify cron คืน CONFIRMED ≤1 นาที)"
  else
    echo "  ✗ restore $case: ค่าไม่ตรง backup — เก็บ backup ไว้ ลองใหม่ (ห้ามลบ)"
    return 1
  fi
}

restore_all() {
  ensure_backup_table
  local any=0 c
  for c in "${CASES[@]}"; do
    if is_fired "$c"; then any=1; restore_one "$c" || true; fi
  done
  [ "$any" = 1 ] || echo "ไม่มีเคสค้างให้ restore"
}

# ─────────────────────── STATUS ───────────────────────
status() {
  ensure_backup_table
  echo "=== LogChain live-demo — สถานะ ==="
  printf "%-9s %-10s %-8s %s\n" CASE BATCH STATUS "ยิงค้าง?"
  local c b st fired
  for c in "${CASES[@]}"; do
    b="${BATCH[$c]}"; st="$(batch_status "$b")"
    fired=$(is_fired "$c" && echo "ใช่ ⚠" || echo "-")
    printf "%-9s %-10s %-8s %s\n" "$c" "${b:0:8}" "$st" "$fired"
  done
  echo "  (move ปลายทาง ${MOVE_DEST:0:8} = $(batch_status "$MOVE_DEST"))"
  echo
  local tamp openint openall rate
  tamp="$(scalar "SELECT count(*) FROM batches WHERE status='TAMPERED'")"
  openint="$(scalar "SELECT count(*) FROM alerts WHERE status='OPEN' AND alert_type='INTEGRITY_TAMPERED'")"
  openall="$(scalar "SELECT count(*) FROM alerts WHERE status='OPEN'")"
  rate="$(scalar "SELECT CASE WHEN count(*) FILTER (WHERE status<>'FAILED')=0 THEN 100 ELSE round(100.0*count(*) FILTER (WHERE status='CONFIRMED')/count(*) FILTER (WHERE status<>'FAILED')) END FROM batches")"
  echo "Chain integrity : ${rate}%  · batches TAMPERED = ${tamp}"
  echo "Alerts OPEN     : ${openall}  (INTEGRITY_TAMPERED = ${openint})"
  echo
  echo "Dashboard: $(dashboard_url)  (หน้า Verify)"
}

usage() {
  cat <<USAGE
ใช้งาน:
  ./live-demo.sh status
  ./live-demo.sh <case>           # ${CASES[*]}
  ./live-demo.sh restore <case>
  ./live-demo.sh restore-all
USAGE
}

# ─────────────────────── main ───────────────────────
cmd="${1:-}"
case "$cmd" in
  ""|-h|--help|help) usage ;;
  status)            status ;;
  restore)           [ $# -ge 2 ] || die "ระบุเคส: ./live-demo.sh restore <case>"; restore_one "$2" ;;
  restore-all)       restore_all ;;
  content|rehash|hash|move|snapshot|dbroot) fire "$cmd" ;;
  *) die "คำสั่งไม่รู้จัก: $cmd"; ;;
esac
