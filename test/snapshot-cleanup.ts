import type { DataSource } from 'typeorm';

/**
 * ลบ snapshot ของ batch ที่เทสสร้าง — ต้องทำก่อน DELETE batches (FK batch_id → batches)
 * batch_log_snapshot เป็น write-only (trg_snapshot_no_delete) เหมือน logs จึงต้องปิด trigger ชั่วคราว
 * เปิดคืนเสมอแม้ DELETE พัง
 */
export async function deleteSnapshotsOf(
  ds: DataSource,
  batchIds: string[],
): Promise<void> {
  if (!batchIds.length) return;
  await ds.query(
    'ALTER TABLE batch_log_snapshot DISABLE TRIGGER trg_snapshot_no_delete',
  );
  try {
    await ds.query('DELETE FROM batch_log_snapshot WHERE batch_id = ANY($1)', [
      batchIds,
    ]);
  } finally {
    await ds.query(
      'ALTER TABLE batch_log_snapshot ENABLE TRIGGER trg_snapshot_no_delete',
    );
  }
}
