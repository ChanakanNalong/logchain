import { useTheme, monoFont } from "@/theme";
import { Th, Td, Badge } from "@/components/ui";

export default function LogTable({ logs }: any) {
  const t = useTheme();
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {["ID", "Timestamp", "Source", "IP", "Event", "Attack Type", "Severity"].map((h) => (
              <Th key={h}>{h}</Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {logs.map((r) => (
            <tr key={r.id}>
              {/* rows carry the full log id; only the display is shortened */}
              <Td style={{ color: t.blue2, ...monoFont }} title={r.id}>
                {typeof r.id === "string" ? r.id.slice(0, 8) : r.id}
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}