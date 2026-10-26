"use client";

/**
 * SVG drawing of a batch's Merkle tree from GET /batches/:id/tree `layers`
 * (leaves at the bottom, root on top). Leaves are small boxes, upper layers
 * grow. Wheel / buttons zoom, drag pans — all inside the frame, the page
 * never scrolls sideways. Hover shows the full hash (+ log id on leaves);
 * click pins the tooltip so its values can be copied.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, Scan, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTheme, monoFont, sansFont } from "@/theme";
import { Button } from "@/components/ui";
import { CopyButton } from "@/components/LogDrawer";
import { shortHash } from "@/lib/format";
import type { PathStep } from "@/lib/merkle";
import type { BatchTree } from "@/types/api";

const ROW_H = 64;
const LABEL_W = 130;

interface NodeBox { x: number; y: number; w: number; h: number }

function layout(tree: BatchTree) {
  const n = tree.layers[0]?.length ?? 0;
  // ≤ 8 leaves: wide enough to print a short hash on every node
  const leafW = n > 40 ? 12 : n > 12 ? 22 : n > 8 ? 44 : 84;
  const gap = n > 40 ? 4 : n > 12 ? 8 : 16;
  const last = tree.layers.length - 1;
  const centers: number[][] = [];
  const boxes: NodeBox[][] = [];
  tree.layers.forEach((layer, L) => {
    const cx = L === 0
      ? layer.map((_, i) => i * (leafW + gap) + leafW / 2)
      : layer.map((_, k) => {
          const below = centers[L - 1];
          const a = below[2 * k];
          const b = below[2 * k + 1];
          return b === undefined ? a : (a + b) / 2;
        });
    centers.push(cx);
    // room between neighbours roughly doubles per layer — grow the boxes with it
    const spacing = (leafW + gap) * 2 ** L;
    let w = Math.min(spacing * 0.85, leafW + L * 18);
    let h = Math.min(12 + L * 4, 36);
    if (n <= 12) h = 26;
    if (L === last) { w = Math.max(w, 96); h = Math.max(h, 30); }
    const y = (last - L) * ROW_H;
    boxes.push(cx.map((c) => ({ x: c - w / 2, y, w, h })));
  });
  const width = Math.max(n * (leafW + gap), 120);
  return { boxes, width, height: tree.layers.length * ROW_H };
}

type View = { x: number; y: number; w: number; h: number };

export default function MerkleTreeView({
  tree,
  path,
  focus,
  onLeafClick,
}: {
  tree: BatchTree;
  /** proof path to highlight — only pass one that matched the backend proof */
  path: PathStep[] | null;
  /** node to ring (step-by-step mode) */
  focus?: { layer: number; index: number } | null;
  onLeafClick?: (leafIndex: number) => void;
}) {
  const t = useTheme();
  const { boxes, width, height } = useMemo(() => layout(tree), [tree]);
  const fit = useCallback((): View => ({ x: -LABEL_W, y: -24, w: width + LABEL_W + 24, h: height + 24 }), [width, height]);
  const [view, setView] = useState<View>(fit);
  useEffect(() => setView(fit()), [fit]);

  const frameRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{ L: number; i: number; px: number; py: number; pinned: boolean } | null>(null);

  // Esc drops a pinned tooltip
  const pinned = !!hover?.pinned;
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setHover(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pinned]);

  // proof ใช้กี่ hash (นับ sibling ที่ไม่ใช่ null) — โชว์เป็นหัวตอนเต็มจอ
  const proofHashes = useMemo(() => (path ?? []).filter((s) => s.sibling !== null).length, [path]);

  // ── โหมดเต็มจอ ──
  const rootRef = useRef<HTMLDivElement>(null);
  const [fs, setFs] = useState(false);
  const enterFs = useCallback(() => {
    setFs(true);
    setView(fit());
    const el = rootRef.current;
    // เต็มจอจริงตอนต่อโปรเจกเตอร์ — ถ้า browser ไม่ให้ ใช้ overlay เฉย ๆ ไม่ error
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => {});
  }, [fit]);
  const exitFs = useCallback(() => {
    setFs(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);
  const toggleFs = useCallback(() => {
    if (fs) exitFs();
    else enterFs();
  }, [fs, enterFs, exitFs]);
  // F11 / Esc ของ browser ออกจาก fullscreen จริง → ปิด overlay ตาม
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFs(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // ในโหมดเต็มจอ: Esc ปิด (ถ้าไม่มี tooltip ปักอยู่) · resize แล้ว fit ใหม่
  useEffect(() => {
    if (!fs) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !hover?.pinned) {
        e.preventDefault();
        exitFs();
      }
    };
    const onResize = () => setView(fit());
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [fs, hover?.pinned, exitFs, fit]);

  const promoted = useMemo(() => new Set(tree.promoted.map((p) => `${p.layer}:${p.index}`)), [tree.promoted]);
  const onPath = useMemo(() => new Set((path ?? []).map((s) => `${s.layer}:${s.index}`)), [path]);
  const siblings = useMemo(
    () => new Set((path ?? []).filter((s) => s.sibling !== null).map((s) => `${s.layer}:${s.sibling}`)),
    [path],
  );
  const last = tree.layers.length - 1;

  /** zoom by `factor` around a point given in client coords (default: centre) */
  const zoom = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const svg = svgRef.current;
    setView((v) => {
      const rect = svg?.getBoundingClientRect();
      const fx = rect && clientX !== undefined ? (clientX - rect.left) / rect.width : 0.5;
      const fy = rect && clientY !== undefined ? (clientY - rect.top) / rect.height : 0.5;
      const w = Math.min(Math.max(v.w * factor, 40), (width + LABEL_W) * 4);
      const h = (v.h / v.w) * w;
      return { x: v.x + (v.w - w) * fx, y: v.y + (v.h - h) * fy, w, h };
    });
  }, [width]);

  // wheel must be non-passive to stop the page from scrolling while zooming
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  function onPointerDown(e: React.PointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const svg = svgRef.current;
    if (!d || !svg) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    const rect = svg.getBoundingClientRect();
    // meet scaling: one screen pixel = the larger of the two ratios in svg units
    const scale = Math.max(view.w / rect.width, view.h / rect.height);
    setView((v) => ({ ...v, x: v.x - dx * scale, y: v.y - dy * scale }));
    d.x = e.clientX;
    d.y = e.clientY;
  }
  function onPointerUp() {
    const moved = drag.current?.moved;
    drag.current = null;
    if (!moved) setHover((h) => (h?.pinned ? null : h));
  }

  function nodeEvents(L: number, i: number) {
    const pos = (e: React.PointerEvent | React.MouseEvent) => {
      const r = frameRef.current!.getBoundingClientRect();
      return { px: e.clientX - r.left, py: e.clientY - r.top };
    };
    return {
      onPointerEnter: (e: React.PointerEvent) => setHover((h) => (h?.pinned ? h : { L, i, ...pos(e), pinned: false })),
      onPointerLeave: () => setHover((h) => (h?.pinned ? h : null)),
      onClick: (e: React.MouseEvent) => {
        e.stopPropagation();
        if (drag.current?.moved) return;
        setHover({ L, i, ...pos(e), pinned: true });
        if (L === 0 && onLeafClick) onLeafClick(i);
      },
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    };
  }

  const nodeStyle = (L: number, i: number) => {
    const key = `${L}:${i}`;
    const isRoot = L === last;
    if (isRoot) {
      const ok = tree.storedHashRootMatchesDb;
      return { fill: ok ? "rgba(52,211,153,0.18)" : "rgba(244,63,94,0.18)", stroke: ok ? t.good : t.danger, sw: 2 };
    }
    if (onPath.has(key)) return { fill: t.blue, stroke: t.blue2, sw: 2 };
    if (siblings.has(key)) return { fill: "rgba(34,211,238,0.22)", stroke: t.cyan, sw: 2 };
    return { fill: L === 0 ? "rgba(59,130,246,0.14)" : t.surface2, stroke: t.border, sw: 1 };
  };

  const hovered = hover && tree.layers[hover.L]?.[hover.i] !== undefined ? hover : null;
  const hoveredLeaf = hovered && hovered.L === 0 ? tree.leaves[hovered.i] : null;

  return (
    <div
      ref={rootRef}
      style={
        fs
          ? {
              position: "fixed", inset: 0, zIndex: 1000, background: t.bg,
              display: "flex", flexDirection: "column", padding: 16, gap: 8,
            }
          : undefined
      }
    >
      {/* หัวเรื่อง proof — โชว์เฉพาะตอนเต็มจอ (ในหน้าปกติ Verify.tsx โชว์อยู่แล้ว) · display คงที่เพื่อไม่ remount frame */}
      <div style={{ display: fs && path ? "block" : "none", fontSize: 13, color: t.muted, marginBottom: 2, ...sansFont }}>
        ใช้ <strong style={{ color: t.text }}>{proofHashes} hash</strong> จาก {tree.logCount.toLocaleString()} log เพื่อพิสูจน์ว่า log นี้อยู่ในต้นไม้
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center", marginBottom: 6 }}>
        <Button variant="ghost" small icon={ZoomIn} onClick={() => zoom(1 / 1.4)} title="ซูมเข้า" ariaLabel="ซูมเข้า">{""}</Button>
        <Button variant="ghost" small icon={ZoomOut} onClick={() => zoom(1.4)} title="ซูมออก" ariaLabel="ซูมออก">{""}</Button>
        <Button variant="ghost" small icon={Scan} onClick={() => setView(fit())} title="พอดีจอ (รีเซ็ตซูม)" ariaLabel="พอดีจอ">พอดีจอ</Button>
        <Button variant="ghost" small icon={fs ? Minimize2 : Maximize2} onClick={toggleFs} title={fs ? "ออกจากเต็มจอ" : "เต็มจอ"} ariaLabel={fs ? "ออกจากเต็มจอ" : "เต็มจอ"}>{""}</Button>
        {fs && <Button variant="ghost" small icon={X} onClick={exitFs} title="ปิด (Esc)" ariaLabel="ปิด">{""}</Button>}
      </div>
      <div
        ref={frameRef}
        style={{
          position: "relative",
          height: fs ? undefined : 380, flex: fs ? "1 1 auto" : undefined, minHeight: fs ? 0 : undefined,
          border: `1px solid ${t.border}`, borderRadius: 10,
          background: t.bg, overflow: "hidden", touchAction: "none", cursor: "grab",
        }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="img"
          aria-label={`Merkle tree: ${tree.layers.map((l) => l.length).join(" → ")} nodes per layer`}
        >
          {/* edges first, under the boxes */}
          {tree.layers.slice(0, -1).map((layer, L) =>
            layer.map((_, i) => {
              const c = boxes[L][i];
              const p = boxes[L + 1][Math.floor(i / 2)];
              const key = `${L}:${i}`;
              const dashed = promoted.has(key);
              const hot = onPath.has(key);
              return (
                <line
                  key={`e${key}`}
                  x1={c.x + c.w / 2} y1={c.y}
                  x2={p.x + p.w / 2} y2={p.y + p.h}
                  stroke={hot ? t.blue2 : t.border}
                  strokeWidth={hot ? 2.5 : 1}
                  strokeDasharray={dashed ? "4 3" : undefined}
                />
              );
            }),
          )}
          {tree.layers.map((layer, L) =>
            layer.map((hash, i) => {
              const b = boxes[L][i];
              const s = nodeStyle(L, i);
              const dashed = promoted.has(`${L}:${i}`);
              const focused = focus && focus.layer === L && focus.index === i;
              return (
                <g key={`n${L}:${i}`} {...nodeEvents(L, i)} style={{ cursor: "pointer" }}>
                  {focused && <rect x={b.x - 4} y={b.y - 4} width={b.w + 8} height={b.h + 8} rx={6} fill="none" stroke={t.warn} strokeWidth={2.5} />}
                  <rect
                    x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(5, b.h / 3)}
                    fill={s.fill} stroke={s.stroke} strokeWidth={s.sw}
                    strokeDasharray={dashed ? "4 3" : undefined}
                  />
                  {b.w >= (fs ? 54 : 70) && (
                    <text
                      x={b.x + b.w / 2} y={b.y + b.h / 2 + 4} textAnchor="middle" fontSize={fs ? 13 : 11}
                      fill={onPath.has(`${L}:${i}`) && L !== last ? "#fff" : t.text}
                      style={{ ...monoFont, pointerEvents: "none" }}
                    >
                      {shortHash(hash, 4, 4)}
                    </text>
                  )}
                </g>
              );
            }),
          )}
          {/* node count per layer, on the left */}
          {tree.layers.map((layer, L) => (
            <text
              key={`l${L}`}
              x={-LABEL_W + 8}
              y={boxes[L][0].y + boxes[L][0].h / 2 + 4}
              fontSize={12}
              fill={t.muted}
              style={{ ...sansFont, pointerEvents: "none" }}
            >
              {L === 0 ? "leaf" : L === last ? "root" : `ชั้น ${L}`} · {layer.length}
            </text>
          ))}
        </svg>

        {hovered && (
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: "absolute",
              left: Math.min(hovered.px + 12, (frameRef.current?.clientWidth ?? 400) - 290),
              top: Math.min(hovered.py + 12, (frameRef.current?.clientHeight ?? 380) - 150),
              width: 280, maxWidth: "calc(100% - 16px)", padding: "8px 10px", borderRadius: 8,
              background: t.surface, border: `1px solid ${t.border}`, boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
              fontSize: 12, color: t.text, zIndex: 2, pointerEvents: hovered.pinned ? "auto" : "none",
            }}
          >
            <div style={{ color: t.muted, ...sansFont }}>
              {hovered.L === 0 ? `leaf #${hovered.i}` : hovered.L === last ? "root" : `ชั้น ${hovered.L} · node #${hovered.i}`}
              {hovered.pinned ? "" : " · คลิกเพื่อปักไว้"}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 4 }}>
              <span style={{ overflowWrap: "anywhere", ...monoFont }}>{tree.layers[hovered.L][hovered.i]}</span>
              {hovered.pinned && <CopyButton value={tree.layers[hovered.L][hovered.i]} />}
            </div>
            {hoveredLeaf && (
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, color: t.muted }}>
                <span style={{ overflowWrap: "anywhere", ...monoFont }}>log {hoveredLeaf.logId}</span>
                {hovered.pinned && <CopyButton value={hoveredLeaf.logId} />}
              </div>
            )}
            {promoted.has(`${hovered.L}:${hovered.i}`) && (
              <div style={{ marginTop: 4, color: t.warn, ...sansFont }}>จำนวนคี่ ส่งต่อขึ้นชั้นบนโดยไม่ hash</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8, fontSize: 11.5, color: t.muted, ...sansFont }}>
        <Legend color={t.blue} border={t.blue2} label="เส้นทางของ log" />
        <Legend color="rgba(34,211,238,0.22)" border={t.cyan} label="sibling ที่ใช้ใน proof" />
        <Legend color={t.surface2} border={t.border} dashed label="node เศษ ส่งขึ้นโดยไม่ hash" />
        <span>ลาก = เลื่อน · ล้อเมาส์ / ปุ่ม = ซูม</span>
      </div>
    </div>
  );
}

function Legend({ color, border, label, dashed }: { color: string; border: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <svg width="16" height="12" aria-hidden="true">
        <rect x="1" y="1" width="14" height="10" rx="3" fill={color} stroke={border} strokeDasharray={dashed ? "3 2" : undefined} />
      </svg>
      {label}
    </span>
  );
}
