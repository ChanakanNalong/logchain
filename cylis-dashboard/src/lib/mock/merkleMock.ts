/**
 * Mock-side Merkle building with real SHA-256 — same rules as the backend
 * MerkleService (see lib/merkle.ts). Lets mock roots, trees and proofs agree
 * with each other and with the browser check on the Verify page.
 */
import { bytesToHex, hexToBytes, sortedPair } from "@/lib/merkle";
import { sha256 } from "./sha256";

const enc = new TextEncoder();

/** sha256 of the rawHash hex text (utf8), 0x-prefixed */
export function leafHash(rawHash: string): string {
  return bytesToHex(sha256(enc.encode(rawHash)));
}

export function parentHash(a: string, b: string): string {
  return bytesToHex(sha256(sortedPair(hexToBytes(a), hexToBytes(b))));
}

/** layers[0] = leaf hashes … last = [root]; odd last node moves up unchanged */
export function buildLayers(rawHashes: string[]): {
  layers: string[][];
  promoted: { layer: number; index: number }[];
  root: string | null;
} {
  if (rawHashes.length === 0) return { layers: [], promoted: [], root: null };
  const layers = [rawHashes.map(leafHash)];
  const promoted: { layer: number; index: number }[] = [];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: string[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      if (i + 1 < cur.length) next.push(parentHash(cur[i], cur[i + 1]));
      else {
        promoted.push({ layer: layers.length - 1, index: i });
        next.push(cur[i]);
      }
    }
    layers.push(next);
  }
  return { layers, promoted, root: layers[layers.length - 1][0] };
}
