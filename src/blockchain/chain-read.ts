import type { BlockchainService } from './blockchain.service';

/** เพดานเวลาอ่าน root จาก chain — public RPC ค้างได้ ห้ามให้ request ค้างตาม */
export const CHAIN_READ_TIMEOUT_MS = 5000;

/**
 * root ของ batch บน contract (getRoot = eth_call ไม่เสีย gas) · lowercase มี 0x
 * พังแบบไหนก็คืน { error } ไม่ throw — ใช้กับ endpoint ที่ต้องตอบ 200 แม้ RPC ล่ม
 * (GET /logs/:id/detail, GET /batches/:id/diff)
 */
export async function readChainRoot(
  blockchain: Pick<BlockchainService, 'ready' | 'getRoot'>,
  batchId: string,
  timeoutMs = CHAIN_READ_TIMEOUT_MS,
): Promise<{ root: string } | { error: string }> {
  if (!blockchain.ready) return { error: 'Blockchain not configured' };

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    const { root } = await Promise.race([blockchain.getRoot(batchId), timeout]);
    return { root: String(root).toLowerCase() };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    return { error: `could not read root from chain: ${msg.slice(0, 200)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** root บน chain ยังว่าง (0x000…) = ยังไม่ถูก anchor */
export const isZeroRoot = (root: string) => /^0x0*$/.test(root);
