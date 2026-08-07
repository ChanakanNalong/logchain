export interface VerifyResult {
  verified?: boolean;
  log?: { rawHash?: string };
  batch?: { merkleRoot?: string; txHash?: string; status?: string };
  proof?: unknown[];
}
