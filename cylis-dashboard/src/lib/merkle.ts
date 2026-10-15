/**
 * Merkle helpers for the Verify page — the same rules as the backend's
 * MerkleService (merkletreejs, sortPairs: true):
 *  - leaf   = sha256(utf8 bytes of the rawHash hex text)
 *  - parent = sha256(the two 32-byte children, smaller one first)
 *  - an odd node at the end of a layer moves up unchanged (no hash)
 * docs/api/merkle-tree.md
 */
import type { BatchTree, ProofStep } from "@/types/api";

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  return "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** The two children in hashing order (sortPairs) */
export function sortedPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [x, y] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const out = new Uint8Array(x.length + y.length);
  out.set(x);
  out.set(y, x.length);
  return out;
}

const eq = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.replace(/^0x/i, "").toLowerCase() === b.replace(/^0x/i, "").toLowerCase();

export interface PathStep {
  layer: number;
  /** the node on the path at this layer */
  index: number;
  hash: string;
  /** null = odd node moved up unchanged (no proof entry for this layer) */
  sibling: number | null;
  siblingHash: string | null;
  /** where the sibling sits — what the backend calls `position` */
  siblingSide: "left" | "right" | null;
}

/**
 * Path from a leaf to the root, from `leafIndex` and the layers alone:
 * at layer L the node is floor(leafIndex / 2^L) — a promoted node also lands
 * on floor(index/2) — and its sibling is index XOR 1 when that exists.
 */
export function proofPath(tree: Pick<BatchTree, "layers">, leafIndex: number): PathStep[] {
  const steps: PathStep[] = [];
  let i = leafIndex;
  for (let L = 0; L < tree.layers.length; L++) {
    const layer = tree.layers[L];
    if (i < 0 || i >= layer.length) return [];
    const last = L === tree.layers.length - 1;
    const sib = last ? null : (i ^ 1) < layer.length ? i ^ 1 : null;
    steps.push({
      layer: L,
      index: i,
      hash: layer[i],
      sibling: sib,
      siblingHash: sib === null ? null : layer[sib],
      siblingSide: sib === null ? null : sib < i ? "left" : "right",
    });
    i = Math.floor(i / 2);
  }
  return steps;
}

/**
 * Does the backend's proof list the siblings this path expects, in order?
 * On a mismatch the page warns instead of highlighting nodes that are not
 * really the proof.
 */
export function checkProofAgainstPath(path: PathStep[], proof: ProofStep[]): { ok: true } | { ok: false; reason: string } {
  const expected = path.filter((s) => s.sibling !== null);
  if (expected.length !== proof.length) {
    return { ok: false, reason: `proof มี ${proof.length} hash แต่ tree ต้องใช้ ${expected.length}` };
  }
  for (let k = 0; k < expected.length; k++) {
    if (!eq(expected[k].siblingHash, proof[k].data)) {
      return { ok: false, reason: `hash ที่ ${k + 1} ของ proof ไม่ตรงกับ sibling ชั้น ${expected[k].layer} ใน tree` };
    }
    if (expected[k].siblingSide !== proof[k].position) {
      return { ok: false, reason: `ตำแหน่ง (left/right) ของ hash ที่ ${k + 1} ไม่ตรงกับ tree` };
    }
  }
  return { ok: true };
}

/** WebCrypto works only in a secure context (https / localhost) */
export function browserHashAvailable(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && !!window.crypto?.subtle;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await window.crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** leaf hash computed in the browser: sha256 of the rawHash text (utf8) */
export async function browserLeafHash(rawHash: string): Promise<string> {
  return bytesToHex(await digest(new TextEncoder().encode(rawHash)));
}

/** parent hash computed in the browser: sha256(sorted pair) */
export async function browserParentHash(a: string, b: string): Promise<string> {
  return bytesToHex(await digest(sortedPair(hexToBytes(a), hexToBytes(b))));
}

export { eq as sameHash };
