import { Injectable } from '@nestjs/common';
import { MerkleTree } from 'merkletreejs';
import { createHash } from 'crypto';

// helper - hash ด้วย sha256 คืนค่าเป็น buffer
function sha256(data: string): Buffer {
  return createHash('sha256').update(data).digest();
}

export interface MerkleProofItem {
  position: 'left' | 'right';
  data: string; // hex string
}

@Injectable()
export class MerkleService {
  /**
   * สร้าง Merkle tree จาก raw_hash ของ logs ทั้ง batch
   * @param leaves array ของ raw_hash (hex string)
   * @returns tree + root
   */
  buildTree(leaves: string[]): { tree: MerkleTree; root: string } {
    // แปลง hax string เป็น buffer แล้ว hash อีกชั้น (leaf hashing)
    const hashedLeaves = leaves.map((leaf) => sha256(leaf));
    const tree = new MerkleTree(hashedLeaves, sha256, { sortPairs: true });
    const root = tree.getHexRoot();
    return { tree, root };
  }
  /** leaf ของ log ใน tree = sha256(utf8 ของ raw_hash hex) — ตัวเดียวกับที่ buildTree ใช้ */
  leafHash(rawHash: string): string {
    return '0x' + sha256(rawHash).toString('hex');
  }

  /**
   * ทุกชั้นของ tree จาก merkletreejs getLayers() (ไม่สร้าง tree เอง) — GET /batches/:id/tree
   * layers[0] = leaf · layers[last] = [root] · promoted = node เศษที่ merkletreejs ส่งต่อขึ้นไปโดยไม่ hash
   * (ชั้นที่มีจำนวนคี่ ตัวสุดท้าย → ชั้นถัดไปตำแหน่ง floor(index/2) ค่าเดิม)
   */
  getLayers(leaves: string[]): {
    layers: string[][];
    promoted: Array<{ layer: number; index: number }>;
    root: string;
  } {
    const { tree, root } = this.buildTree(leaves);
    const layers = tree
      .getLayers()
      .map((layer) => layer.map((node) => '0x' + node.toString('hex')));
    const promoted: Array<{ layer: number; index: number }> = [];
    for (let l = 0; l < layers.length - 1; l++) {
      if (layers[l].length % 2 === 1) {
        promoted.push({ layer: l, index: layers[l].length - 1 });
      }
    }
    return { layers, promoted, root };
  }

  /**
   * สร้าง Merkle proof สำหรับ log ตัวเดียว
   * proof นี้ใช้พิสูจน์ว่า log อยู่ใน tree โดยไม่ต้องมี log ตัวอื่น
   */
  getProof(leaves: string[], targetLeaf: string): MerkleProofItem[] {
    const { tree } = this.buildTree(leaves);
    const targetHash = sha256(targetLeaf);
    return tree.getProof(targetHash).map((p) => ({
      position: p.position,
      data: '0x' + p.data.toString('hex'),
    }));
  }
  /**
   * verify ว่า proof ถูกต้อง — leaf + proof สร้าง root ที่ตรงกับที่บันทึกไว้ไหม
   */
  verifyProof(leaf: string, proof: MerkleProofItem[], root: string): boolean {
    const targetHash = sha256(leaf);
    const proofBuffers = proof.map((p) => ({
      position: p.position,
      data: Buffer.from(p.data.replace('0x', ''), 'hex'),
    }));
    return MerkleTree.verify(proofBuffers, targetHash, root, sha256, {
      sortPairs: true,
    });
  }
}
