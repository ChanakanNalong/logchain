/**
 * What to say when the chain holds no root for a batch (eth_call returns
 * 0x000…). Shared by the log drawer's chain check and the batch diff, so the
 * same batch reads the same on both pages. Never a tamper verdict.
 */
export interface RootStateView {
  /** Badge tone: slateMuted (dark grey, muted text) or orange */
  tone: "slateMuted" | "orange";
  label: string;
  note: string;
}

export function unanchoredRootView(batchStatus: string | null | undefined): RootStateView {
  // not sent yet vs sent (or tried) but missing — told apart by the batch status
  if (batchStatus === "SEALED" || batchStatus === "PENDING") {
    return { tone: "slateMuted", label: "ยังไม่ได้ส่ง root ขึ้นเชน (รอ anchor)", note: "batch นี้ seal แล้วแต่ยังไม่ได้ส่ง root ขึ้นเชน" };
  }
  if (batchStatus === "FAILED") {
    return { tone: "orange", label: "ส่ง root ขึ้นเชนไม่สำเร็จ", note: "anchor ไม่สำเร็จ บนเชนจึงไม่มี root ของ batch นี้ — ไม่ได้แปลว่าข้อมูลถูกแก้" };
  }
  return { tone: "orange", label: "ไม่พบ root บนเชน", note: "ส่ง root ขึ้นเชนแล้ว แต่ไม่พบ root ของ batch นี้บนเชน — ไม่ได้แปลว่าข้อมูลถูกแก้" };
}
