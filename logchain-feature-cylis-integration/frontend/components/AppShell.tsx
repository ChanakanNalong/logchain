'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
} from 'lucide-react';
import { darkTheme, lightTheme, monoFont, sansFont } from '@/lib/theme';
import { ThemeContext } from '@/lib/theme-context';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, title: 'Security overview' },
  { href: '/logs', label: 'Logs', icon: ScrollText, title: 'Log explorer' },
  { href: '/ml', label: 'ML Detection', icon: Brain, title: 'ML Detection — DeepLog' },
  { href: '/dataset', label: 'Dataset', icon: Database, title: 'Dataset — HDFS_v1' },
  { href: '/verify', label: 'Verify', icon: ShieldCheck, title: 'Integrity verification' },
  { href: '/reports', label: 'Reports', icon: FileBarChart2, title: 'Incident reports' },
  { href: '/settings', label: 'Settings', icon: SettingsIcon, title: 'Alerts & access' },
];

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mode, setMode] = useState<'dark' | 'light'>('dark');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  const formattedNow = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(now)
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {} as Record<string, string>);

  const clockLabel = `${formattedNow.year}-${formattedNow.month}-${formattedNow.day} ${formattedNow.hour}:${formattedNow.minute}:${formattedNow.second} ICT`;

  const theme = mode === 'dark' ? darkTheme : lightTheme;
  const isDark = mode === 'dark';
  const active = NAV_ITEMS.find((item) => item.href === pathname) ?? NAV_ITEMS[0];

  return (
    <ThemeContext.Provider value={theme}>
      <div
        style={{
          height: '100vh',
          width: '100vw',
          background: theme.bg,
          color: theme.text,
          position: 'fixed',
          top: 0,
          left: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          transition: 'background .3s,color .3s',
          ...sansFont,
        }}
      >
        {/* Ambient glow */}
        <div
          style={{
            position: 'absolute',
            top: -120,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 900,
            height: 360,
            background: `radial-gradient(ellipse at center,${theme.glow} 0%,rgba(34,211,238,0.06) 40%,transparent 72%)`,
            filter: 'blur(10px)',
            pointerEvents: 'none',
          }}
        />

        <div style={{ position: 'relative', display: 'flex', flex: 1, minHeight: 0, width: '100%' }}>
          {/* Sidebar */}
          <aside
            style={{
              width: 220,
              flexShrink: 0,
              padding: '24px 14px',
              borderRight: `1px solid ${theme.border}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              height: '100%',
              overflowY: 'auto',
              background: theme.sidebar,
              transition: 'background .3s',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 22px' }}>
              <div
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 7,
                  background: `linear-gradient(135deg,${theme.blue},${theme.cyan})`,
                }}
              />
              <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.01em', color: '#f1f5f9', ...sansFont }}>
                Cylis
              </span>
              <span style={{ fontSize: 10, color: '#64748b', ...monoFont }}>v0.3</span>
            </div>

            {NAV_ITEMS.map((item) => {
              const isActive = item.href === active.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderRadius: 9,
                    fontSize: 13.5,
                    fontWeight: 600,
                    letterSpacing: '0.01em',
                    textAlign: 'left',
                    background: isActive ? 'rgba(59,130,246,0.18)' : 'transparent',
                    color: isActive ? '#60a5fa' : '#94a3b8',
                    border: isActive ? '1px solid rgba(59,130,246,0.35)' : '1px solid transparent',
                    textDecoration: 'none',
                    ...sansFont,
                  }}
                >
                  <item.icon size={15} />
                  {item.label}
                </Link>
              );
            })}

            <div style={{ marginTop: 'auto', padding: '14px 12px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <div style={{ fontSize: 11, color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
                <Earth size={12} /> Polygon PoS · KRaft
              </div>
            </div>
          </aside>

          {/* Main content */}
          <main style={{ flex: 1, padding: '24px 28px 60px', overflowY: 'auto', height: '100%', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
              <div>
                <div
                  style={{
                    fontSize: 10.5,
                    color: theme.muted,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    ...sansFont,
                    fontWeight: 600,
                  }}
                >
                  LogChain · {active.label}
                </div>
                <h1 style={{ margin: '3px 0 0', fontSize: 24, fontWeight: 700, letterSpacing: '-0.015em', ...sansFont }}>
                  {active.title}
                </h1>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Clock size={14} color={theme.muted} />
                <span style={{ fontSize: 12, color: theme.muted, ...monoFont, letterSpacing: '0.02em' }}>
                  {clockLabel}
                </span>
                <button
                  onClick={() => setMode(isDark ? 'light' : 'dark')}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '6px 14px',
                    borderRadius: 20,
                    background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
                    border: `1px solid ${theme.border}`,
                    color: theme.muted,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    ...sansFont,
                    transition: 'all .2s',
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

            {children}
          </main>
        </div>
      </div>
    </ThemeContext.Provider>
  );
}
