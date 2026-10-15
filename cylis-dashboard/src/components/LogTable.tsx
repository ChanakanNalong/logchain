import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useTheme, monoFont } from "@/theme";
import { Th, Td, Badge } from "@/components/ui";
import BatchStatusBadge from "@/components/BatchStatusBadge";
import type { LogRow } from "@/lib/logRows";

/**
 * คัดลอกข้อความลง clipboard
 * navigator.clipboard ใช้ได้เฉพาะ secure context (https / localhost) — ถ้าเปิด
 * dashboard ผ่าน IP ในแลนจะโยน error ทิ้ง เลยต้องมีทางถอยแบบ execCommand ไว้
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/**
 * ช่อง ID: โชว์ 8 ตัวแรกพอให้อ่านออก แต่คลิกแล้วได้ UUID เต็มไปวางในหน้า Verify
 * (GET /logs/:id/proof ต้องการตัวเต็ม ถ้าส่ง 8 ตัวจะเป็น 400 ทันที)
 */
export function IdCell({ id }: { id: string }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied && !failed) return;
    const timer = setTimeout(() => { setCopied(false); setFailed(false); }, 1600);
    return () => clearTimeout(timer);
  }, [copied, failed]);

  async function onCopy() {
    const ok = await copyText(id);
    setCopied(ok);
    setFailed(!ok);
  }

  return (
    <button
      type="button"
      // rows can be clickable (open the log drawer) — copying must not open it too
      onClick={(e) => { e.stopPropagation(); void onCopy(); }}
      title={copied ? "Copied" : `Click to copy the full ID — ${id}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 7px",
        marginLeft: -7,
        borderRadius: 7,
        background: "transparent",
        border: `1px solid ${copied ? "rgba(52,211,153,0.35)" : "transparent"}`,
        color: failed ? t.danger : copied ? t.good : t.blue2,
        fontSize: 13,
        cursor: "pointer",
        ...monoFont,
      }}
    >
      {id.slice(0, 8)}
      {copied ? <Check size={12} /> : failed ? null : <Copy size={12} opacity={0.65} />}
      {failed && <span style={{ fontSize: 11 }}>copy failed</span>}
    </button>
  );
}

/** Tx link to the explorer — opens a new tab without handing it `window.opener` */
export function PolygonscanLink({ url, label = "Polygonscan" }: { url: string; label?: string }) {
  const t = useTheme();
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open the anchoring tx on Polygonscan"
      style={{ display: "inline-flex", alignItems: "center", gap: 4, color: t.blue2, fontSize: 12, textDecoration: "none", whiteSpace: "nowrap" }}
    >
      {label} <ExternalLink size={12} />
    </a>
  );
}

interface LogTableProps {
  logs: LogRow[];
  /** add the On-chain column (batch status + tx link) */
  showChain?: boolean;
  /** makes rows clickable / keyboard-openable */
  onRowClick?: (row: LogRow) => void;
}

export default function LogTable({ logs, showChain = false, onRowClick }: LogTableProps) {
  const t = useTheme();
  const headers = ["ID", "Timestamp", "Source", "IP", "Event", "Attack Type", "Severity", ...(showChain ? ["On-chain"] : [])];
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {headers.map((h) => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map((r) => (
            <tr
              key={r.id}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRowClick(r); }
                    }
                  : undefined
              }
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick ? `Open log ${r.id}` : undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
            >
              {/* rows carry the full log id; only the display is shortened */}
              <Td style={{ color: t.blue2, ...monoFont }}>
                {typeof r.id === "string" && r.id.length > 8
                  ? <IdCell id={r.id} />
                  : r.id}
              </Td>
              <Td style={{ color: t.muted, ...monoFont }}>{r.ts}</Td>
              <Td>{r.source}</Td>
              <Td style={{ ...monoFont }}>{r.ip}</Td>
              <Td>{r.event}</Td>
              <Td style={{ color: t.muted }}>{r.attackType}</Td>
              <Td>
                {/* show the severity the backend actually stored (CRITICAL / WARNING /
                    INFO / …); `sev` only picks the colour, it is not the label */}
                <Badge tone={r.sev}>{r.severity ?? "—"}</Badge>
              </Td>
              {showChain && (
                <Td>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <BatchStatusBadge status={r.batchStatus} />
                    {r.polygonscanUrl && <PolygonscanLink url={r.polygonscanUrl} label="tx" />}
                  </div>
                </Td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
