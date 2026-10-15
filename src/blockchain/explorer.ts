/** explorer ของ Amoy — ตั้ง BLOCKCHAIN_EXPLORER_TX_URL= (ว่าง) เพื่อปิด เช่นบน Hardhat */
export const DEFAULT_EXPLORER_TX_URL = 'https://amoy.polygonscan.com/tx/';

/** ลิงก์ tx บน explorer · ไม่มี tx หรือปิด explorer = null */
export function explorerTxUrl(
  txHash: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!txHash) return null;
  const base = env.BLOCKCHAIN_EXPLORER_TX_URL ?? DEFAULT_EXPLORER_TX_URL;
  return base.trim() ? base.trim() + txHash : null;
}
