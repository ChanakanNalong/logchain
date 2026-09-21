import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { ScrollText, ShieldCheck, Boxes, TriangleAlert } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Card, SectionLabel, Badge } from "@/components/ui";
import LogTable from "@/components/LogTable";
import { api } from "@/lib/api";
import { mapLog, unwrapLogs } from "@/lib/logRows";

/** Shape of GET /api/v1/stats/overview */
interface Overview {
  totalLogs: number;
  sealedLogs: number;
  batches: {
    confirmed: number;
    tampered: number;
    total: number;
    byStatus: Record<string, number>;
  };
  integrityRate: number;
  openAlerts: number;
  traffic: { h: string; total: number }[];
  topSources: { ip: string; hits: number }[];
}

/** Shape of GET /api/v1/stats/traffic?range=… */
interface TrafficSeries {
  range: RangeKey;
  /** bucket width the API picked, e.g. "hour" — shown as "Events per hour" */
  bucket: string;
  points: { t: string; label: string; total: number }[];
}

/** Time ranges offered above the log-volume chart. Keys go straight to ?range= */
const TRAFFIC_RANGES = [
  { key: "1h", label: "1H", title: "last 1 hour" },
  { key: "6h", label: "6H", title: "last 6 hours" },
  { key: "24h", label: "24H", title: "last 24 hours" },
  { key: "7d", label: "7D", title: "last 7 days" },
  { key: "30d", label: "30D", title: "last 30 days" },
  { key: "6m", label: "6M", title: "last 6 months" },
  { key: "12m", label: "12M", title: "last 12 months" },
  { key: "all", label: "All", title: "all time" },
] as const;

type RangeKey = (typeof TRAFFIC_RANGES)[number]["key"];

const DEFAULT_RANGE: RangeKey = "24h";

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

/** Segmented 1H / 6H / … / All picker for the traffic chart */
function RangePicker({ value, onChange }: { value: RangeKey; onChange: (r: RangeKey) => void }) {
  const t = useTheme();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {TRAFFIC_RANGES.map((r) => {
        const active = r.key === value;
        return (
          <button
            key={r.key}
            type="button"
            onClick={() => onChange(r.key)}
            aria-pressed={active}
            title={`Log volume — ${r.title}`}
            style={{
              padding: "4px 9px",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              background: active ? "rgba(59,130,246,0.14)" : "transparent",
              color: active ? t.blue2 : t.muted,
              border: `1px solid ${active ? "rgba(59,130,246,0.35)" : t.border}`,
              ...monoFont,
            }}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

function buildKpis(o: Overview) {
  return [
    {
      label: "Total Logs",
      value: o.totalLogs.toLocaleString(),
      delta: `${o.sealedLogs.toLocaleString()} sealed in batches`,
      tone: "blue",
      icon: ScrollText,
    },
    {
      label: "Chain Integrity",
      value: `${o.integrityRate}%`,
      delta: `${o.batches.tampered} tampered`,
      tone: o.batches.tampered > 0 ? "danger" : "good",
      icon: ShieldCheck,
    },
    {
      label: "Confirmed Batches",
      value: o.batches.confirmed.toLocaleString(),
      delta: `${o.batches.total} batches total`,
      tone: "blue",
      icon: Boxes,
    },
    {
      label: "Open Alerts",
      value: o.openAlerts.toLocaleString(),
      delta: o.openAlerts === 0 ? "nothing open" : "awaiting triage",
      tone: o.openAlerts > 0 ? "warn" : "good",
      icon: TriangleAlert,
    },
  ];
}

export default function Dashboard() {
  const t = useTheme();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [range, setRange] = useState<RangeKey>(DEFAULT_RANGE);
  const [traffic, setTraffic] = useState<TrafficSeries | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(true);
  const [trafficError, setTrafficError] = useState("");

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      api.get("/stats/overview"),
      api.get("/logs", { params: { limit: 5 } }),
    ])
      .then(([statsRes, logsRes]) => {
        if (cancelled) return;
        setOverview(statsRes.data);
        setRecentLogs(unwrapLogs(logsRes.data).slice(0, 5).map(mapLog));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("dashboard fetch failed", e);
        setError(
          e.response?.status === 403
            ? "Not authorised — this account needs the analyst, operator or admin role."
            : "Could not load dashboard data.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // กราฟแยก endpoint กับ KPI — เปลี่ยนช่วงเวลาแล้วยิงแค่ซีรีส์ ไม่ต้องโหลดทั้งหน้าใหม่
  useEffect(() => {
    let cancelled = false;
    setTrafficLoading(true);
    // ล้าง error ของช่วงก่อนหน้าด้วย — chartBody() เช็ค trafficError ก่อนอย่างอื่น
    // ถ้าไม่ล้าง กดสลับช่วงหลังยิงพลาดจะเห็นข้อความ error เดิมค้างแทนกราฟที่กำลังโหลด
    setTrafficError("");

    api
      .get("/stats/traffic", { params: { range } })
      .then((res) => {
        if (cancelled) return;
        setTraffic(res.data);
        setTrafficError("");
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("traffic fetch failed", e);
        setTrafficError("Could not load the log volume chart.");
      })
      .finally(() => {
        if (!cancelled) setTrafficLoading(false);
      });

    return () => { cancelled = true; };
  }, [range]);

  const placeholder = (text: string) => (
    <div style={{ color: t.muted, padding: 20, textAlign: "center", fontSize: 13 }}>{text}</div>
  );

  if (loading) return <Card>{placeholder("Loading dashboard…")}</Card>;
  if (error) return <Card><div style={{ color: t.danger, padding: 20, fontSize: 13 }}>{error}</div></Card>;
  if (!overview) return <Card>{placeholder("No data available")}</Card>;

  const kpis = buildKpis(overview);
  const topSources = overview.topSources ?? [];
  const activeRange = TRAFFIC_RANGES.find((r) => r.key === range)!;
  const points = traffic?.points ?? [];
  // /stats/traffic builds every series with generate_series + LEFT JOIN, so it always
  // returns a full grid of buckets — a quiet day comes back as zeros, not as [].
  // Checking length alone would render a blank chart instead of saying why.
  const hasTraffic = points.some((p) => p.total > 0);

  /** What to show inside the chart box — an explanation beats an empty grid */
  const chartBody = () => {
    if (trafficError) return <div style={{ color: t.danger, padding: 20, fontSize: 13 }}>{trafficError}</div>;
    if (trafficLoading && !traffic) return placeholder("Loading chart…");
    if (!hasTraffic) {
      return placeholder(
        range === "all"
          ? "No logs ingested yet"
          : `No logs ingested in the ${activeRange.title}`,
      );
    }
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points} barCategoryGap="32%">
          <defs>
            <linearGradient id="pillGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={t.cyan} stopOpacity={1} />
              <stop offset="45%" stopColor={t.blue2} stopOpacity={0.95} />
              <stop offset="100%" stopColor={t.blue} stopOpacity={0.25} />
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
            dataKey="label"
            stroke={t.muted}
            fontSize={11}
            tickLine={false}
            axisLine={{ stroke: t.border }}
            tick={{ ...monoFont, fill: t.muted }}
            // ช่วงกว้างๆ มี bucket เยอะ ปล่อยให้ recharts ข้ามป้ายที่ชนกันเอง
            interval="preserveStartEnd"
            minTickGap={18}
            dy={6}
          />
          <YAxis
            stroke={t.muted}
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tick={{ ...monoFont, fill: t.muted }}
            width={36}
            allowDecimals={false}
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
            labelFormatter={(label) => `${label} UTC`}
          />
          <Bar dataKey="total" shape={(props) => <PillBar {...props} fill="url(#pillGrad)" />} filter="url(#pillGlow)" />
        </BarChart>
      </ResponsiveContainer>
    );
  };

  return (
    <div style={{ display: "grid", gap: 20 }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
        {kpis.map((k) => (
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

      {/* Traffic chart + top source IPs */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
            <div>
              <SectionLabel>Log volume — {activeRange.title} (UTC)</SectionLabel>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: t.muted, ...sansFont, fontWeight: 500 }}>
                <span style={{ width: 7, height: 7, borderRadius: 3, background: t.blue2, boxShadow: `0 0 6px ${t.blue2}` }} />
                Events per {traffic?.bucket ?? "hour"}
              </span>
            </div>
            <RangePicker value={range} onChange={setRange} />
          </div>
          {/* ระหว่างสลับช่วงเวลาให้กราฟเดิมจางไว้ก่อน — ไม่ให้การ์ดกะพริบเป็นช่องว่าง */}
          <div style={{ height: 230, marginTop: 18, opacity: trafficLoading && traffic ? 0.45 : 1, transition: "opacity 120ms" }}>
            {chartBody()}
          </div>
        </Card>

        <Card>
          <SectionLabel dot={t.cyan}>Top source IPs</SectionLabel>
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {topSources.length === 0
              ? placeholder("No source IPs recorded")
              : topSources.map((s) => (
                  <div key={s.ip} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 13, ...monoFont }}>{s.ip}</div>
                    <div style={{ fontSize: 11, color: t.muted }}>{s.hits.toLocaleString()} hits</div>
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
        {recentLogs.length === 0 ? placeholder("No logs yet") : <LogTable logs={recentLogs} />}
      </Card>
    </div>
  );
}
