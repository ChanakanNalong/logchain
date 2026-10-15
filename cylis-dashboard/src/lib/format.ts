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
