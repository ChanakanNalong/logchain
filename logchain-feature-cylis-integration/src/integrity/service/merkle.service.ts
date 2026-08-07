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
        const hashedLeaves = leaves.map(leaf => sha256(leaf));
        const tree = new MerkleTree(hashedLeaves, sha256, { sortPairs: true });
        const root = tree.getHexRoot();
        return { tree, root };
    }
    /**
    * สร้าง Merkle proof สำหรับ log ตัวเดียว
    * proof นี้ใช้พิสูจน์ว่า log อยู่ใน tree โดยไม่ต้องมี log ตัวอื่น
    */
    getProof(leaves: string[], targetLeaf: string): MerkleProofItem[] {
        const { tree } = this.buildTree(leaves);
        const targetHash = sha256(targetLeaf);
        return tree.getProof(targetHash).map(p => ({
            position: p.position,
            data: '0x' + p.data.toString('hex'),
        }));
    }
    /**
       * verify ว่า proof ถูกต้อง — leaf + proof สร้าง root ที่ตรงกับที่บันทึกไว้ไหม
       */
    verifyProof(leaf: string, proof: MerkleProofItem[], root: string): boolean {
        const targetHash = sha256(leaf);
        const proofBuffers = proof.map(p => ({
            position: p.position,
            data: Buffer.from(p.data.replace('0x', ''), 'hex'),
        }));
        return MerkleTree.verify(proofBuffers, targetHash, root, sha256, { sortPairs: true });

    }
}


