import type { BarProps } from 'recharts';

/** Rounded "pill" bar shape with a subtle highlight, used for the traffic chart */
export default function PillBar({ x = 0, y = 0, width = 0, height = 0, fill }: BarProps) {
  const w = Math.min(Number(width), 14);
  const bx = Number(x) + Number(width) / 2 - w / 2;
  const r = w / 2;
  if (Number(height) <= 0) return null;
  return (
    <g>
      <rect x={bx} y={y} width={w} height={height} rx={r} ry={r} fill={fill} />
      <ellipse cx={bx + r} cy={Number(y) + r * 0.9} rx={r * 0.6} ry={r * 0.6} fill="rgba(255,255,255,0.35)" />
    </g>
  );
}
