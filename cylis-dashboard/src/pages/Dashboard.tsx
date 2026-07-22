import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { useTheme, monoFont, sansFont } from "../theme.js";
import { Card, SectionLabel, Badge } from "../components/ui.tsx";
import LogTable from "../components/LogTable.tsx";
import { kpiCards, trafficByHour, topAttackSources, recentLogs } from "../data/mockData.js";

/** Rounded "pill" bar shape with a subtle highlight, used for the traffic chart */
function PillBar({ x, y, width, height, fill }: any) {
  const w = Math.min(width, 14);
  const bx = x + width / 2 - w / 2;
  const r = w / 2;
  if (height <= 0) return null;
  return (
    <g>
      <rect x={bx} y={y} width={w} height={height} rx={r} ry={r} fill={fill} />
      <ellipse cx={bx + r} cy={y + r * 0.9} rx={r * 0.6} ry={r * 0.6} fill="rgba(255,255,255,0.35)" />
    </g>
  );
}

export default function Dashboard() {
  const t = useTheme();

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
        {kpiCards.map((k) => (
          <Card key={k.label}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <SectionLabel dot={t[k.tone] || t.blue}>{k.label}</SectionLabel>
              <k.icon size={15} color={t.muted} />
            </div>
            <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em", marginTop: 6, ...monoFont }}>
              {k.value}
            </div>
            <div style={{ fontSize: 12, color: t.muted, marginTop: 4, ...sansFont, fontWeight: 500 }}>
              {k.delta}
            </div>
          </Card>
        ))}
      </div>

      {/* Traffic chart + top attack sources */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <SectionLabel>Traffic vs anomalies — last 24h</SectionLabel>
            <div style={{ display: "flex", gap: 14 }}>
              {[{ c: t.blue2, l: "Normal" }, { c: t.danger, l: "Spike hour" }].map((leg) => (
                <span
                  key={leg.l}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: t.muted, ...sansFont, fontWeight: 500 }}
                >
                  <span
                    style={{ width: 7, height: 7, borderRadius: 3, background: leg.c, boxShadow: `0 0 6px ${leg.c}` }}
                  />
                  {leg.l}
                </span>
              ))}
            </div>
          </div>
          <div style={{ height: 230, marginTop: 18 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trafficByHour} barCategoryGap="32%">
                <defs>
                  <linearGradient id="pillGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={t.cyan} stopOpacity={1} />
                    <stop offset="45%" stopColor={t.blue2} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={t.blue} stopOpacity={0.25} />
                  </linearGradient>
                  <linearGradient id="pillGradHot" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fda4af" stopOpacity={1} />
                    <stop offset="45%" stopColor={t.danger} stopOpacity={0.95} />
                    <stop offset="100%" stopColor={t.danger} stopOpacity={0.2} />
                  </linearGradient>
                  <filter id="pillGlow" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="3.2" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <CartesianGrid stroke={t.border} strokeDasharray="3 6" vertical={false} />
                <XAxis
                  dataKey="h"
                  stroke={t.muted}
                  fontSize={11}
                  tickLine={false}
                  axisLine={{ stroke: t.border }}
                  tick={{ ...monoFont, fill: t.muted }}
                  dy={6}
                />
                <YAxis
                  stroke={t.muted}
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tick={{ ...monoFont, fill: t.muted }}
                  width={36}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  contentStyle={{
                    background: t.surface2,
                    border: `1px solid ${t.border}`,
                    borderRadius: 10,
                    fontSize: 12,
                    ...monoFont,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}
                  labelStyle={{ color: t.text, ...sansFont, fontWeight: 600 }}
                  formatter={(val, name) => [val, name === "total" ? "Events" : name]}
                />
                <Bar
                  dataKey="total"
                  shape={(props) => (
                    <PillBar {...props} fill={props.payload.isSpike ? "url(#pillGradHot)" : "url(#pillGrad)"} />
                  )}
                  filter="url(#pillGlow)"
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <SectionLabel dot={t.cyan}>Top attack sources</SectionLabel>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {topAttackSources.map((s) => (
              <div key={s.ip} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, ...monoFont }}>{s.ip}</div>
                  <div style={{ fontSize: 11, color: t.muted }}>
                    {s.country} · {s.hits} hits
                  </div>
                </div>
                <Badge tone={s.risk}>{s.risk === "danger" ? "high" : s.risk === "warn" ? "med" : "low"}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Recent logs */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <SectionLabel>Recent logs</SectionLabel>
          <Badge tone="blue">live</Badge>
        </div>
        <LogTable logs={recentLogs.slice(0, 5)} />
      </Card>
    </div>
  );
}