/** Display helpers shared by the log/alert views. Values stay whole in state; only the text is shortened. */

/** First 8 chars of a UUID — enough to tell rows apart */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** `0x1234ab…ef56` — keeps the 0x prefix when there is one */
export function shortHash(hash: string | null | undefined, head = 6, tail = 4): string {
  if (!hash) return "—";
  const prefix = hash.startsWith("0x") ? "0x" : "";
  const body = hash.slice(prefix.length);
  if (body.length <= head + tail + 1) return hash;
  return `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** Local time as `YYYY-MM-DD HH:mm:ss` (sv-SE gives that layout) */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("sv-SE");
}

/** True for a root that was never written on chain (`0x000…0`) */
export function isZeroRoot(root: string | null | undefined): boolean {
  return !root || /^(0x)?0*$/i.test(root);
}

/**
 * Significant digits for every cost amount (POL / ETH / THB) on every page —
 * Batch audit and Verify must print the same number for the same batch.
 */
export const COST_SIG = 5;

const WEI_DECIMALS = 18;
const GWEI_DECIMALS = 9;
// tsconfig targets ES2017, which has no `10n` literal syntax — build BigInts by call
const ZERO = BigInt(0);
const TEN = BigInt(10);

/** "25" / "25.000000031" / 25 → integer scaled by 10^decimals; null if not a plain non-negative decimal */
function toUnits(v: string | number, decimals: number): bigint | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(decimals) : "") : v.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * TEN ** BigInt(decimals) + BigInt(frac || "0");
}

/**
 * An integer amount in 10^-decimals units as plain decimal text — never
 * exponent notation (8e-8). Keeps `sig` significant digits after the leading
 * zeros, so tiny per-log costs still read as numbers: 0.00001954.
 */
export function formatUnits(amount: bigint, decimals: number, sig = 4): string {
  const neg = amount < ZERO;
  const abs = neg ? -amount : amount;
  const base = TEN ** BigInt(decimals);
  const int = abs / base;
  const fracDigits = (abs % base).toString().padStart(decimals, "0");
  let frac: string;
  if (int > ZERO) {
    frac = fracDigits.slice(0, Math.max(0, sig - int.toString().length + 2));
  } else {
    const firstNonZero = fracDigits.search(/[1-9]/);
    frac = firstNonZero < 0 ? "" : fracDigits.slice(0, firstNonZero + sig);
  }
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${int.toString()}${frac ? "." + frac : ""}`;
}

/**
 * Anchoring cost in POL from gas used × effective gas price (gwei), exact in
 * BigInt. `perLog` divides by the real log count. null when gas is missing.
 */
export function polCost(
  gasUsed: string | number | null | undefined,
  gasPriceGwei: string | number | null | undefined,
  logCount: number,
): { batch: string; perLog: string | null } | null {
  if (gasUsed == null || gasPriceGwei == null) return null;
  const gas = toUnits(gasUsed, 0);
  const priceWei = toUnits(gasPriceGwei, GWEI_DECIMALS);
  if (gas === null || priceWei === null) return null;
  const wei = gas * priceWei;
  return {
    batch: formatUnits(wei, WEI_DECIMALS, COST_SIG),
    perLog: logCount > 0 ? formatUnits(wei / BigInt(logCount), WEI_DECIMALS, COST_SIG) : null,
  };
}

/** 78156 → "78,156"; null / unparsable → "—" */
export function fmtInt(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = toUnits(v, 0);
  return n === null ? "—" : n.toLocaleString("en-US");
}

/**
 * A decimal from the API as plain text: strings pass through, numbers are
 * written out without exponent notation (8e-8 → "0.00000008").
 */
export function plainDecimal(v: string | number | null | undefined): string {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "—";
  const s = Math.abs(v) < 1e-6 || Math.abs(v) >= 1e21 ? v.toFixed(20) : String(v);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * A decimal (string or number) shortened to `sig` significant digits after
 * the leading zeros — still plain text, never exponent notation. The full
 * value belongs in a tooltip.
 */
export function fmtDecimal(v: string | number | null | undefined, sig = COST_SIG): string {
  const text = plainDecimal(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const frac = m[3] ?? "";
  return formatUnits(BigInt(m[1] + m[2] + frac), frac.length, sig);
}

/** Gas price in gwei, at most 2 decimals: 25.000000031 → "25", 30.5 → "30.5" */
export function fmtGwei(v: string | number | null | undefined): string {
  const text = plainDecimal(v);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  // round half up at the 2nd decimal, in BigInt so long strings stay exact
  const frac = (m[2] ?? "").padEnd(3, "0");
  let cents = BigInt(m[1]) * BigInt(100) + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += BigInt(1);
  return formatUnits(cents, 2, 64);
}
