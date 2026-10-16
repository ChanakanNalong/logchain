import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { useTheme, sansFont, monoFont } from "@/theme";

/**
 * FilterDropdown's look, but several values at once (OR), with an optional
 * text box for a value that is not in `options`. Commas are rejected because
 * the API takes these lists comma-joined.
 */
export default function MultiSelectDropdown({
  label,
  options,
  value,
  onChange,
  allowCustom = false,
}: {
  label: string;
  options: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
  allowCustom?: boolean;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // selected values that came from the URL or the text box stay listed
  const all = [...options, ...value.filter((v) => !options.includes(v))];
  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);

  const customValue = custom.trim();
  const customInvalid = customValue.includes(",");
  function addCustom() {
    if (!customValue || customInvalid) return;
    if (!value.includes(customValue)) onChange([...value, customValue]);
    setCustom("");
  }

  const summary = value.length === 0 ? `All ${label}` : value.length === 1 ? value[0] : `${label}: ${value.length}`;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 9,
          background: value.length ? "rgba(59,130,246,0.14)" : t.surface2,
          border: `1px solid ${value.length ? "rgba(59,130,246,0.4)" : t.border}`,
          color: t.text, fontSize: 12.5, fontWeight: 600, cursor: "pointer", ...sansFont,
        }}
      >
        {summary}
        <ChevronDown size={13} color={t.muted} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 220, maxWidth: "calc(100vw - 32px)",
            background: t.surface2, border: `1px solid ${t.border}`, borderRadius: 10,
            boxShadow: "0 10px 28px rgba(0,0,0,0.4)", padding: 6, zIndex: 20,
          }}
        >
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {all.map((opt) => {
              const on = value.includes(opt);
              return (
                <button
                  key={opt}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  onClick={() => toggle(opt)}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                    padding: "8px 10px", borderRadius: 7, background: on ? "rgba(59,130,246,0.12)" : "transparent",
                    border: "none", color: t.text, fontSize: 12.5, textAlign: "left", cursor: "pointer", ...monoFont,
                  }}
                >
                  {opt}
                  {on && <Check size={13} color={t.blue2} />}
                </button>
              );
            })}
          </div>
          {allowCustom && (
            <div style={{ borderTop: `1px solid ${t.border}`, marginTop: 6, paddingTop: 6 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }}
                  placeholder="พิมพ์ค่าอื่น…"
                  aria-label={`Add a ${label} value`}
                  style={{
                    flex: 1, minWidth: 0, background: t.surface, border: `1px solid ${customInvalid ? t.danger : t.border}`,
                    borderRadius: 7, padding: "6px 8px", color: t.text, fontSize: 12.5, outline: "none", ...monoFont,
                  }}
                />
                <button
                  type="button"
                  onClick={addCustom}
                  disabled={!customValue || customInvalid}
                  aria-label="Add"
                  style={{
                    background: t.blue, border: "none", borderRadius: 7, padding: "0 8px", color: "#fff",
                    cursor: !customValue || customInvalid ? "not-allowed" : "pointer",
                    opacity: !customValue || customInvalid ? 0.45 : 1, display: "flex", alignItems: "center",
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
              {customInvalid && <div style={{ color: t.danger, fontSize: 11, marginTop: 4 }}>ห้ามมีเครื่องหมาย ,</div>}
            </div>
          )}
          {value.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{ marginTop: 6, width: "100%", padding: "6px 10px", borderRadius: 7, background: "transparent", border: `1px solid ${t.border}`, color: t.muted, fontSize: 12, cursor: "pointer", ...sansFont }}
            >
              ล้าง {label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
