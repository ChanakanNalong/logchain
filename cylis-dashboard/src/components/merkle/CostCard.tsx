/**
 * Anchoring cost of one batch (GET /batches/:id/tree → cost): one tx per log
 * vs the whole batch in one tx. Values come from the backend as exact decimal
 * text; they are only shortened for display (full value in the tooltip) and
 * never shown in exponent form. Uses the batch's real logCount.
 */
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel } from "@/components/ui";
import { fmtDecimal, fmtGwei, fmtInt, plainDecimal } from "@/lib/format";
import type { BatchTree, Decimalish } from "@/types/api";

function Num({ v, unit }: { v: Decimalish | null | undefined; unit?: string }) {
  const t = useTheme();
  if (v == null) return <span style={{ color: t.muted }}>—</span>;
  return (
    <span title={`${plainDecimal(v)}${unit ? " " + unit : ""}`} style={monoFont}>
      {fmtDecimal(v)}{unit ? <span style={{ color: t.muted }}> {unit}</span> : null}
    </span>
  );
}

export default function CostCard({ tree }: { tree: BatchTree }) {
  const t = useTheme();
  const c = tree.cost;
  const asOf = c?.rates.asOf ?? null;

  return (
    <Card>
      <SectionLabel dot={t.warn}>ค่าใช้จ่ายการส่ง root ขึ้นเชน</SectionLabel>
      {!c ? (
        <div style={{ color: t.muted, fontSize: 13, padding: "10px 0" }}>
          {/* has a tx = it was sent, only the gas was not recorded (receipt missing / not backfilled) */}
          {tree.txHash ? "ยังไม่ได้บันทึก gas ของ tx นี้" : "batch นี้ยังไม่ได้ส่งขึ้นเชน"}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: t.muted, margin: "4px 0 10px", ...monoFont }}>
            {fmtInt(c.gasUsed)} gas × {fmtGwei(c.effectiveGasPriceGwei)} gwei · {tree.logCount.toLocaleString()} {tree.logCount === 1 ? "log" : "logs"}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr>
                  {["", "1 ล็อก / 1 tx", "ทั้ง batch / 1 tx"].map((h) => (
                    <th key={h} style={{ textAlign: h ? "right" : "left", padding: "6px 10px", color: t.muted, fontSize: 11.5, fontWeight: 600, ...sansFont }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ["จำนวน tx", <span key="a" style={monoFont}>{tree.logCount.toLocaleString()}</span>, <span key="b" style={monoFont}>1</span>],
                  ["POL", <Num key="a" v={c.oneTxPerLogCostPol} />, <Num key="b" v={c.batchCostPol} />],
                  ["ETH", <Num key="a" v={c.eth?.oneTxPerLog} />, <Num key="b" v={c.eth?.batch} />],
                  ["บาท", <Num key="a" v={c.thb?.oneTxPerLog} />, <Num key="b" v={c.thb?.batch} />],
                  ["ต่อ 1 ล็อก", <Num key="a" v={c.batchCostPol} unit="POL" />, <Num key="b" v={c.perLogCostPol} unit="POL" />],
                ] as const).map(([label, a, b]) => (
                  <tr key={label}>
                    <td style={{ padding: "8px 10px", borderTop: `1px solid ${t.border}`, color: t.muted, whiteSpace: "nowrap" }}>{label}</td>
                    <td style={{ padding: "8px 10px", borderTop: `1px solid ${t.border}`, textAlign: "right", whiteSpace: "nowrap" }}>{a}</td>
                    <td style={{ padding: "8px 10px", borderTop: `1px solid ${t.border}`, textAlign: "right", whiteSpace: "nowrap", color: t.good }}>{b}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(!c.eth || !c.thb) && (
            <div style={{ fontSize: 12, color: t.muted, marginTop: 6 }}>ETH / บาท: — = ยังไม่ได้ตั้งอัตราแปลง</div>
          )}
          <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            {tree.logCount === 1 ? (
              <span style={{ fontSize: 15, fontWeight: 600, color: t.muted }}>batch มี 1 ล็อก ไม่มีส่วนประหยัด</span>
            ) : (
              <>
                <span style={{ fontSize: 34, fontWeight: 800, color: t.good, letterSpacing: "-0.02em", ...monoFont }}>
                  ประหยัด ×{plainDecimal(c.savingFactor)}
                </span>
                <span style={{ fontSize: 12.5, color: t.muted }}>รวม {tree.logCount.toLocaleString()} ล็อกเป็น tx เดียว</span>
              </>
            )}
          </div>
        </>
      )}
      <div style={{ marginTop: 12, fontSize: 12, color: t.muted, lineHeight: 1.6 }}>
        {asOf && (
          <>
            อัตรา ณ: <strong style={{ color: t.text }}>{asOf}</strong>
            <br />
          </>
        )}
        ETH / บาท = มูลค่า POL ที่จ่ายจริง แปลงตามอัตราที่ตั้งไว้{asOf ? ` ณ ${asOf}` : ""} ไม่ใช่ราคาสด และไม่ใช่ค่า gas ถ้ารันบน Ethereum
      </div>
    </Card>
  );
}
