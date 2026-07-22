import { Injectable,Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ethers } from "ethers";
import { VaultService } from "../vault/vault.service";

// ABI แบบ minimal — แค่ 3 function ที่ใช้จริง
// รูปแบบนี้เรียก "Human-Readable ABI" ของ ethers
const CONTRACT_ABI = [
    'function storeRoot(bytes32 batch, bytes32 root) external',
    'function verifyRoot(bytes32 batch, bytes32 root) external view returns (bool)',
    'function getRoot(bytes32 batch) external view returns (bytes32 root, uint256 timestamp)',
    'event RootStored(bytes32 indexed batch, bytes32 root, uint256 timestamp)',
];

@Injectable()
export class BlockchainService implements OnModuleInit {
    private readonly logger = new Logger(BlockchainService.name);
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private contract: ethers.Contract;
    private isReady = false;

    constructor(
      private readonly configService: ConfigService,
      private readonly vaultService: VaultService,
    ) {}

    async onModuleInit() {
        try {
            const rpcUrl = this.configService.get<string>('BLOCKCHAIN_RPC_URL', 'http://127.0.0.1:8545');
            // private key มาจาก Vault ไม่ใช่ .env แล้ว
            const pk = this.vaultService.get().blockchain.privateKey;
            const address = this.configService.get<string>('CONTRACT_ADDRESS');

            if (!pk || !address) {
                this.logger.warn('Blockchain config missing - integrity disabled');
                return;
            }

            // provider - เชื่อมกับ RPC node (Hardhat local หรือ Polygon Amoy)
            this.provider = new ethers.JsonRpcProvider(rpcUrl);
            // wallet - บัญชีใฃ้เซ้น transaction (จ่าย gas)
            this.wallet = new ethers.Wallet(pk, this.provider);
            // contract instance - ผูก address + ABI + wallet
            this.contract = new ethers.Contract(address, CONTRACT_ABI, this.wallet);

            this.isReady = true;
            this.logger.log(`Blockchain connected: ${rpcUrl} contract=${address}`);
        } catch (err) {
            this.logger.error('Blockchain init failed', err);
        }
}

/**
   * แปลง string เป็น bytes32 (รูปแบบที่ contract ต้องการ)
   * ใช้ keccak256 hash ของ string
   */
  private toBytes32(value: string): string {
    return ethers.id(value); // ethers.id() = keccak256(utf8Bytes(value))
  }

  /**   
   * เก็บ Merkle root ของ batch ขึ้น blockchain
   * @returns transaction hash + block number
   */
    async storeRoot(batchId: string, merkleRoot: string): Promise<{ txHash: string, blockNumber: number }> {
        if (!this.isReady) throw new Error('Blockchain not ready');

        const batchBytes = this.toBytes32(batchId);
        // merkleRoot จาก merkletreejs เป็น '0x...' อยู่แล้ว ใช้ตรงๆ ได้
        const rootBytes = merkleRoot.startsWith('0x') ? merkleRoot : '0x' + merkleRoot;

        this.logger.log(`Storing root for batch ${batchId}...`);
        const tx = await this.contract.storeRoot(batchBytes, rootBytes);
        // รอ transaction ถูก mine (confirm) ก่อน
        const receipt = await tx.wait();

        this.logger.log(`Root stored tx=${receipt.hash} block=${receipt.blockNumber}`);
        return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
    }

    /**
   * verify ว่า root ที่เก็บไว้ตรงกับที่ส่งมาไหม
   * ถ้าไม่ตรง = ข้อมูลถูก tamper
   */
  async verifyRoot(batchId: string, merkleRoot: string): Promise<boolean> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const batchBytes = this.toBytes32(batchId);
    const rootBytes = merkleRoot.startsWith('0x') ? merkleRoot : '0x' + merkleRoot;

    return this.contract.verifyRoot(batchBytes, rootBytes);
  }

   /**
   * ดึง root + timestamp ที่เก็บไว้บน chain
   */
  async getRoot(batchId: string): Promise<{ root: string, timestamp: number }> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const batchBytes = this.toBytes32(batchId);
    const result = await this.contract.getRoot(batchBytes);
    return { root: result.root, timestamp: Number(result.timestamp) };
  }

  /**
   * ตรวจสถานะ root บน chain - แยก "ไม่มีบน chain" ออกจาก "มีแต่ไม่ตรง"
   * 
   * MATCH    = root ตรง -> integrity ผ่าน
   * MISSING  = ไม่มี root ของ batch นี้บน chain (tx หาย / chain / ยังไม่ confirm)
   *          -> verify ไม่ได้ ไม่ใช่หลักฐานว่าถูกแก้ไข
   * MISMATCH = มี root บน chain แต่ไม่ตรงกับที่คำนวณใหม่ -> ข้อมูลถูกแก้ไขจริง
   */
  async checkRoot(
    batchId: string,
    merkleRooT: string,
  ): Promise<{ result: 'MATCH' | 'MISSING' | 'MISMATCH'; onChainRoot: string }> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const { root: onChainRoot } = await this.getRoot(batchId);
    const expected = (merkleRooT.startsWith('0x') ? merkleRooT : '0x' + merkleRooT).toLowerCase();

    // bytes32 ที่ไม่เคยถูกเซ็ต จะเป็น 0x000...0
    if (/^0x0+$/.test(onChainRoot)) {
      return { result: 'MISSING', onChainRoot };
    }
    return {
      result: onChainRoot.toLowerCase() === expected ? 'MATCH' : 'MISMATCH',
      onChainRoot,
    };
  }

  get ready(): boolean {
    return this.isReady
  }
}