"use client";

import { useState, useEffect, Suspense } from "react";
import {
  LayoutDashboard,
  ScrollText,
  Brain,
  Database,
  ShieldCheck,
  FileBarChart2,
  Settings as SettingsIcon,
  Clock,
  Bell,
  Sun,
  Moon,
  Earth,
} from "lucide-react";
import { darkTheme, lightTheme, ThemeContext } from "@/theme";
import { keycloak } from "@/lib/keycloak";
import Dashboard from "@/views/Dashboard";
import Logs from "@/views/Logs";
import MLDetection from "@/views/MLDetection";
import Dataset from "@/views/Dataset";
import Verify from "@/views/Verify";
import Reports from "@/views/Reports";
import Settings from "@/views/Settings";
import { sansFont, monoFont } from "@/theme";

const NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, Page: Dashboard },
  { id: "logs", label: "Logs", icon: ScrollText, Page: Logs },
  { id: "ml", label: "ML Detection", icon: Brain, Page: MLDetection },
  { id: "dataset", label: "Dataset", icon: Database, Page: Dataset },
  { id: "verify", label: "Verify", icon: ShieldCheck, Page: Verify },
  { id: "reports", label: "Reports", icon: FileBarChart2, Page: Reports },
  { id: "settings", label: "Settings", icon: SettingsIcon, Page: Settings },
];

const PAGE_TITLES = {
  dashboard: "Security overview",
  logs: "Log explorer",
  ml: "ML Detection — DeepLog",
  dataset: "Dataset — HDFS_v1",
  verify: "Integrity verification",
  reports: "Incident reports",
  settings: "Alerts & access",
};

export default function App() {
  const [activeId, setActiveId] = useState("dashboard");
  const [mode, setMode] = useState("dark"); // "dark" | "light"
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const formattedNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {} as Record<string, string>);

  const clockLabel = `${formattedNow.year}-${formattedNow.month}-${formattedNow.day} ${formattedNow.hour}:${formattedNow.minute}:${formattedNow.second} ICT`;

  const theme = mode === "dark" ? darkTheme : lightTheme;
  const isDark = mode === "dark";

  // Hiding the link is just a UX shortcut to avoid a dead-end click — the
  // admin endpoints behind Settings enforce the admin role themselves on
  // every request, regardless of what's shown in this sidebar.
  const visibleNavItems = NAV_ITEMS.filter(
    (item) => item.id !== "settings" || keycloak.hasRealmRole("admin"),
  );
  const active = visibleNavItems.find((item) => item.id === activeId) ?? visibleNavItems[0];
  const ActivePage = active.Page;

  return (
    <ThemeContext.Provider value={theme}>
      <div
        style={{
          height: "100vh",
          width: "100vw",
          background: theme.bg,
          color: theme.text,
          fontFamily: "var(--font-sans),system-ui,sans-serif",
          position: "fixed",
          top: 0,
          left: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          transition: "background .3s,color .3s",
        }}
      >
        {/* Ambient glow */}
        <div
          style={{
            position: "absolute",
            top: -120,
            left: "50%",
            transform: "translateX(-50%)",
            width: 900,
            height: 360,
            background: `radial-gradient(ellipse at center,${theme.glow} 0%,rgba(34,211,238,0.06) 40%,transparent 72%)`,
            filter: "blur(10px)",
            pointerEvents: "none",
          }}
        />

        <div style={{ position: "relative", display: "flex", flex: 1, minHeight: 0, width: "100%" }}>
          {/* Sidebar */}
          <aside
            style={{
              width: 220,
              flexShrink: 0,
              padding: "24px 14px",
              borderRight: `1px solid ${theme.border}`,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              height: "100%",
              overflowY: "auto",
              background: theme.sidebar,
              transition: "background .3s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px 22px" }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  background: `linear-gradient(135deg,${theme.blue},${theme.cyan})`,
                }}
              />
              <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.01em", color: "#f1f5f9", ...sansFont }}>
                Cylis
              </span>
              <span style={{ fontSize: 10, color: "#64748b", ...monoFont }}>v0.3</span>
            </div>

            {visibleNavItems.map((item) => {
              const isActive = item.id === activeId;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveId(item.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "9px 12px",
                    borderRadius: 9,
                    fontSize: 13.5,
                    fontWeight: 600,
                    letterSpacing: "0.01em",
                    textAlign: "left",
                    background: isActive ? "rgba(59,130,246,0.18)" : "transparent",
                    color: isActive ? "#60a5fa" : "#94a3b8",
                    border: isActive ? "1px solid rgba(59,130,246,0.35)" : "1px solid transparent",
                    cursor: "pointer",
                    ...sansFont,
                  }}
                >
                  <item.icon size={15} />
                  {item.label}
                </button>
              );
            })}

            <div style={{ marginTop: "auto", padding: "14px 12px", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ fontSize: 11, color: "#64748b", display: "flex", alignItems: "center", gap: 6 }}>
                <Earth size={12} /> Polygon Amoy · Dev
              </div>
            </div>
          </aside>

          {/* Main content */}
          <main style={{ flex: 1, padding: "24px 28px 60px", overflowY: "auto", height: "100%", minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: theme.muted,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    ...sansFont,
                    fontWeight: 600,
                  }}
                >
                  LogChain · {active.label}
                </div>
                <h1 style={{ margin: "3px 0 0", fontSize: 24, fontWeight: 700, letterSpacing: "-0.015em", ...sansFont }}>
                  {PAGE_TITLES[activeId]}
                </h1>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Clock size={14} color={theme.muted} />
                <span style={{ fontSize: 12, color: theme.muted, ...monoFont, letterSpacing: "0.02em" }}>
                  {clockLabel}
                </span>
                <button
                  onClick={() => setMode(isDark ? "light" : "dark")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "6px 14px",
                    borderRadius: 20,
                    background: isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.07)",
                    border: `1px solid ${theme.border}`,
                    color: theme.muted,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: 600,
                    ...sansFont,
                    transition: "all .2s",
                  }}
                >
                  {isDark ? (
                    <>
                      <Sun size={13} color="#f59e0b" />
                      <span style={{ color: theme.text }}>Light</span>
                    </>
                  ) : (
                    <>
                      <Moon size={13} color="#6366f1" />
                      <span style={{ color: theme.text }}>Dark</span>
                    </>
                  )}
                </button>
                <Bell size={16} color={theme.muted} />
              </div>
            </div>

            <Suspense fallback={null}>
              <ActivePage />
            </Suspense>
          </main>
        </div>
      </div>
    </ThemeContext.Provider>
  );
}