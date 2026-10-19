/**
 * Small text diffs for the "at seal | now" compare in the log drawer
 * (components/SnapshotPanel.tsx). No dependency: a word-level LCS for free
 * text and a position-by-position compare for fixed-length hex.
 */

export interface Segment {
  text: string;
  /** true = not on the other side (removed on the left, added on the right) */
  changed: boolean;
}

export interface SideBySide {
  left: Segment[];
  right: Segment[];
}

/** Past this many characters a side, the caller highlights the whole row instead */
export const MAX_DIFF_CHARS = 2000;
/** LCS table cap (rows × cols) — keeps the worst case to a few ms */
const MAX_LCS_CELLS = 250_000;

function push(out: Segment[], text: string, changed: boolean) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.changed === changed) last.text += text;
  else out.push({ text, changed });
}

/** Words and the whitespace between them, both kept so the text joins back exactly */
function tokens(s: string): string[] {
  return s.split(/(\s+)/).filter((x) => x !== "");
}

/** Word-level diff (LCS over words + whitespace) · null when a side is too long */
export function wordDiff(before: string, after: string): SideBySide | null {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return null;
  const a = tokens(before);
  const b = tokens(after);
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) return null;

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const cols = b.length + 1;
  const lcs = new Uint16Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] = a[i] === b[j]
        ? lcs[(i + 1) * cols + j + 1] + 1
        : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const left: Segment[] = [];
  const right: Segment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(left, a[i++], false);
      push(right, b[j++], false);
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      push(left, a[i++], true);
    } else {
      push(right, b[j++], true);
    }
  }
  while (i < a.length) push(left, a[i++], true);
  while (j < b.length) push(right, b[j++], true);
  return { left, right };
}

/** Character-by-position diff — for hashes, where an LCS would only invent matches */
export function charDiff(before: string, after: string): SideBySide | null {
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return null;
  const left: Segment[] = [];
  const right: Segment[] = [];
  const n = Math.max(before.length, after.length);
  for (let k = 0; k < n; k++) {
    const x = before[k];
    const y = after[k];
    if (x !== undefined) push(left, x, x !== y);
    if (y !== undefined) push(right, y, x !== y);
  }
  return { left, right };
}
