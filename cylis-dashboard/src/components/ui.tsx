import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";

/** Card container with surface background + border */
export function Card({ children, style }: any) {
  const t = useTheme();
  return (
    <div
      style={{
        background: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: 14,
        padding: 20,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Small uppercase label with a colored dot, used as a section heading */
export function SectionLabel({ children, dot }: any) {
  const t = useTheme();
  const color = dot || t.blue;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          boxShadow: `0 0 8px ${color}`,
        }}
      />
      <span
        style={{
          fontSize: 10.5,
          letterSpacing: "0.16em",
          textTransform: "uppercase",
          color: t.muted,
          fontWeight: 600,
          ...sansFont,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** Pill-shaped status badge */
export function Badge({ children, tone = "neutral" }: any) {
  const t = useTheme();
  const tones = {
    neutral: { bg: "rgba(124,135,163,0.12)", fg: t.muted, bd: t.border },
    blue: { bg: "rgba(59,130,246,0.12)", fg: t.blue2, bd: "rgba(59,130,246,0.35)" },
    danger: { bg: "rgba(244,63,94,0.12)", fg: t.danger, bd: "rgba(244,63,94,0.35)" },
    warn: { bg: "rgba(245,158,11,0.12)", fg: t.warn, bd: "rgba(245,158,11,0.35)" },
    good: { bg: "rgba(52,211,153,0.12)", fg: t.good, bd: "rgba(52,211,153,0.35)" },
    cyan: { bg: "rgba(34,211,238,0.12)", fg: t.cyan, bd: "rgba(34,211,238,0.35)" },
  };
  const c = tones[tone] || tones.neutral;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
        ...monoFont,
      }}
    >
      {children}
    </span>
  );
}

/** Button — variants: primary | ghost | subtle */
export function Button({ children, variant = "primary", icon: Icon, onClick, small, disabled }: any) {
  const t = useTheme();
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    borderRadius: 10,
    fontSize: small ? 12.5 : 13.5,
    fontWeight: 600,
    padding: small ? "7px 13px" : "9px 17px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    border: "1px solid transparent",
    ...sansFont,
  };
  const variants = {
    primary: { background: t.blue, color: "#fff" },
    ghost: { background: "transparent", color: t.text, border: `1px solid ${t.border}` },
    subtle: { background: t.surface2, color: t.text, border: `1px solid ${t.border}` },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant] }}>
      {Icon && <Icon size={small ? 13 : 15} />}
      {children}
    </button>
  );
}

/** Table header cell */
export function Th({ children }: any) {
  const t = useTheme();
  return (
    <th
      style={{
        padding: "8px 10px",
        textAlign: "left",
        color: t.muted,
        fontSize: 10.5,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 600,
        ...sansFont,
      }}
    >
      {children}
    </th>
  );
}

/** Table body cell */
export function Td({ children, style, ...rest }: any) {
  const t = useTheme();
  return (
    <td style={{ padding: "10px", borderTop: `1px solid ${t.border}`, ...style }} {...rest}>
      {children}
    </td>
  );
}

/** Button + popup dropdown, reused for both the attack-type and severity filters */
export function FilterDropdown({ value, onChange, options }: any) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 12px",
          borderRadius: 9,
          background: t.surface2,
          border: `1px solid ${t.border}`,
          color: t.text,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: "pointer",
          ...sansFont,
        }}
      >
        {value}
        <ChevronDown
          size={13}
          color={t.muted}
          style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}
        />
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: 200,
            background: t.surface2,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.4)",
            padding: 6,
            zIndex: 20,
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          {options.map((opt: string) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 7,
                background: opt === value ? "rgba(59,130,246,0.12)" : "transparent",
                border: "none",
                color: t.text,
                fontSize: 12.5,
                textAlign: "left",
                cursor: "pointer",
                ...sansFont,
              }}
            >
              {opt}
              {opt === value && <Check size={13} color={t.blue2} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
