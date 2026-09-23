import { Logger } from '@nestjs/common';

/**
 * error ของ ethers v6 มีทั้ง `code` (เช่น TIMEOUT, NETWORK_ERROR) และ `shortMessage` เสมอ
 * error ทั่วไปของ Node มี `code` ได้ (ECONNREFUSED) แต่ไม่มี `shortMessage` จึงใช้คู่นี้แยก
 */
export function isEthersError(
  reason: unknown,
): reason is { code: string; shortMessage: string } {
  if (typeof reason !== 'object' || reason === null) return false;
  const r = reason as Record<string, unknown>;
  return typeof r.code === 'string' && typeof r.shortMessage === 'string';
}

/**
 * กันไม่ให้ ethers ที่ reject หลุดนอกสาย await ฆ่าทั้ง process
 *
 * เจอมาแล้ว 2 ครั้ง (network detection ก่อนใส่ staticNetwork · NonceManager) ทั้งคู่เป็น promise
 * ภายใน ethers ที่ไม่มีใคร await → Node ตายทั้ง API gateway เพราะ RPC ของ chain สะดุด
 * anchor เป็นชั้นเสริม ไม่ควรลาก ingest/alert ตายตาม
 *
 * **เฉพาะ error ของ ethers เท่านั้น** — rejection อื่นโยนต่อเป็น uncaught exception ให้ตาย
 * เหมือน default ของ Node (fail fast) ไม่งั้นบั๊กจริงจะถูกกลบเงียบ
 *
 * @returns ฟังก์ชันถอด handler (ใช้ในเทสต์)
 */
export function installUnhandledRejectionGuard(
  onEthersRejection: (code: string) => void,
  logger = new Logger('UnhandledRejection'),
): () => void {
  const handler = (reason: unknown) => {
    if (!isEthersError(reason)) throw reason;

    logger.error(
      `Unhandled ethers rejection (${reason.code}): ${reason.shortMessage} — process kept alive`,
      reason instanceof Error ? reason.stack : undefined,
    );
    onEthersRejection(reason.code);
  };
  process.on('unhandledRejection', handler);
  return () => process.off('unhandledRejection', handler);
}
