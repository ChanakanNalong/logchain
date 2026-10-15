/**
 * ทศนิยมแบบ exact บน bigint — ค่าเงิน/gas ใน API ส่งเป็น string ทศนิยม (ไม่ใช่ float / 1e-7)
 * ค่า = int / 10^scale
 */
export interface Dec {
  int: bigint;
  scale: number;
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** "0.0000625" → Dec · ค่าว่าง / ไม่ใช่ทศนิยมบวก = null */
export function parseDec(raw: string | undefined | null): Dec | null {
  const v = raw?.trim();
  if (!v || !DECIMAL_RE.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return { int: BigInt(whole + frac), scale: frac.length };
}

/** wei → POL/ETH (18 ตำแหน่ง) · wei → gwei ใช้ scale 9 */
export const fromUnits = (int: bigint, scale: number): Dec => ({ int, scale });

export const mul = (a: Dec, b: Dec): Dec => ({
  int: a.int * b.int,
  scale: a.scale + b.scale,
});

export const mulInt = (a: Dec, n: bigint): Dec => ({
  int: a.int * n,
  scale: a.scale,
});

/** หารด้วยจำนวนเต็ม — ปัดลงที่ extra ตำแหน่งเพิ่ม (หารไม่ลงตัว เช่น /3) */
export function divInt(a: Dec, n: bigint, extra = 12): Dec {
  return { int: (a.int * 10n ** BigInt(extra)) / n, scale: a.scale + extra };
}

/** Dec → "0.00078156" (ตัด 0 ท้าย · ไม่มี exponent) */
export function formatDec(d: Dec): string {
  const neg = d.int < 0n;
  const digits = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, '0');
  const whole = digits.slice(0, digits.length - d.scale) || '0';
  const frac = digits.slice(digits.length - d.scale).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
}
