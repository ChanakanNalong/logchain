"use client";

import { createContext, useContext } from "react";

// Dark navy theme (default)
export const darkTheme = {
  bg: "#0a0e17",
  surface: "#0f1521",
  surface2: "#141b2c",
  border: "#1f2940",
  blue: "#3b82f6",
  blue2: "#60a5fa",
  cyan: "#22d3ee",
  text: "#e6e9f2",
  muted: "#7c87a3",
  danger: "#f43f5e",
  warn: "#f59e0b",
  good: "#34d399",
  sidebar: "#0a0e17",
  sidebarText: "#94a3b8",
  sidebarActive: "#60a5fa",
  glow: "rgba(59,130,246,0.22)",
};

// Light theme
export const lightTheme = {
  bg: "#f0f4fa",
  surface: "#ffffff",
  surface2: "#e8eef8",
  border: "#d0d9ec",
  blue: "#2563eb",
  blue2: "#3b82f6",
  cyan: "#0891b2",
  text: "#0f172a",
  muted: "#64748b",
  danger: "#e11d48",
  warn: "#d97706",
  good: "#059669",
  sidebar: "#1e293b",
  sidebarText: "#94a3b8",
  sidebarActive: "#60a5fa",
  glow: "rgba(59,130,246,0.08)",
};

// Font families come from next/font (see src/app/layout.tsx), which exposes
// them as the --font-mono / --font-sans CSS variables on <html>.
export const monoFont = {
  fontFamily: "var(--font-mono),ui-monospace,monospace",
  fontFeatureSettings: "'tnum' 1,'zero' 1",
};

export const sansFont = {
  fontFamily: "var(--font-sans),system-ui,sans-serif",
};

export type Theme = typeof darkTheme;

export const ThemeContext = createContext<Theme>(darkTheme);
export const useTheme = () => useContext(ThemeContext);
