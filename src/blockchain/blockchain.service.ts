import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { VaultService } from '../vault/vault.service';

// ABI แบบ minimal — แค่ 3 function ที่ใช้จริง
// รูปแบบนี้เรียก "Human-Readable ABI" ของ ethers
const CONTRACT_ABI = [
  'function storeRoot(bytes32 batch, bytes32 root) external',
  'function verifyRoot(bytes32 batch, bytes32 root) external view returns (bool)',
  'function getRoot(bytes32 batch) external view returns (bytes32 root, uint256 timestamp)',
  'event RootStored(bytes32 indexed batch, bytes32 root, uint256 timestamp)',
];

/**
 * ผลของการส่ง storeRoot ขึ้น chain
 * confirmed=false = tx ส่งไปแล้วแต่ยังไม่ถูก mine ในเวลาที่รอ (มี txHash ให้ตามต่อได้)
 */
export interface StoreRootResult {
  txHash: string;
  blockNumber: number | null;
  confirmed: boolean;
}

/**
 * ชนิดของ revert ที่ storeRoot เจอได้ — แยก "ไม่ใช่ความผิดพลาดจริง" ออกจาก error อื่น
 *
 * ROOT_EXISTS    = require(roots[id] == 0, "Root already exists") ใน LogIntegrity
 *                  root ของ batch นี้ถูก anchor ไปแล้ว = งานสำเร็จไปแล้ว ไม่ใช่ FAILED
 *                  เจอบ่อยบน Amoy เพราะ chain state ไม่ reset เหมือน Hardhat node
 * NOT_AUTHORIZED = require(msg.sender == owner, "Not authorized")
 *                  wallet ที่ใช้เซ็นไม่ใช่ owner ของ contract = misconfig ไม่ใช่ปัญหาของ batch
 * OTHER          = อย่างอื่น (gas, nonce, RPC ล่ม, ...)
 */
export type ChainWriteError = 'ROOT_EXISTS' | 'NOT_AUTHORIZED' | 'OTHER';

/**
 * รอ tx confirm ได้นานสุดเท่าไร (ms) ก่อนจะปล่อยให้ batch ไปรอ verify รอบถัดไป
 * วัดจริงบน Amoy: seal → confirm ใช้ ~6.2-6.5 วิ (block ~2 วิ) — 120 วิเผื่อไว้เยอะแล้ว
 * ที่ต้องมีเพดานเพราะ tx.wait() ไม่มี timeout ในตัว ถ้า public RPC ค้าง
 * cron seal จะค้างตามไปด้วย แล้ว batch จะติด PENDING ตลอดกาล
 */
export const DEFAULT_TX_TIMEOUT_MS = 120_000;

/**
 * หลังส่ง tx สำเร็จ เชื่อ nonce ที่จำไว้เองแทน chain ได้นานสุดเท่าไร (ms)
 * public RPC เป็น load balancer — ถาม "pending" ทันทีหลังส่งอาจไปโดน node ที่ยังไม่เห็น tx
 * แล้วได้ nonce เดิมกลับมา (ชนกัน) · พ้นช่วงนี้ไปแล้วเชื่อ chain เสมอ ไม่ให้ tx ที่ถูก drop
 * จาก mempool ทิ้ง nonce ที่จำไว้ค้างจนเกิดช่องว่างถาวร
 */
const NONCE_HINT_TTL_MS = 60_000;

/** ต่อ RPC ไม่ติดตอน boot → ลองใหม่ 5s, 10s, 20s, ... ตันที่ 5 นาที (ไม่ยอมแพ้) */
export const INIT_RETRY_BASE_MS = 5_000;
export const INIT_RETRY_MAX_MS = 300_000;

/** ค่าที่แปลว่า "ยังไม่ได้ตั้ง": ว่าง · CHANGE_ME* ของ .env.example · zero address */
function isUnsetPlaceholder(value: string | undefined | null): boolean {
  if (!value || value.trim() === '') return true;
  if (/^(0x)?CHANGE_ME/i.test(value.trim())) return true;
  return /^0x0{40}$/i.test(value.trim());
}

export function classifyChainError(err: unknown): ChainWriteError {
  const e = err as any;
  // ethers v6 วาง revert string ไว้หลายที่ — รวมทุกที่แล้วค่อยจับ
  const text = [e?.reason, e?.shortMessage, e?.revert?.args?.[0], e?.message]
    .filter((v) => typeof v === 'string')
    .join(' | ')
    .toLowerCase();

  if (text.includes('root already exists')) return 'ROOT_EXISTS';
  if (text.includes('not authorized')) return 'NOT_AUTHORIZED';
  return 'OTHER';
}

@Injectable()
export class BlockchainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BlockchainService.name);
  private provider: ethers.JsonRpcProvider;
  /**
   * Wallet ธรรมดา ไม่ใช่ ethers.NonceManager — NonceManager (6.17) มีบั๊กสองตัว:
   *  1. sendTransaction เริ่ม getNonce ไว้แล้วไป await populateTransaction ก่อน ถ้า populate
   *     พังก่อน (RPC timeout) promise ของ nonce ไม่มีใคร await → unhandled rejection
   *     ฆ่าทั้ง process (เจอจริง: "request timeout" หลัง Anchor batch ... ไม่สำเร็จ)
   *  2. นับ nonce +1 ก่อนรู้ว่าส่งสำเร็จ และไม่เคย reset — send ที่ revert ตอน estimateGas
   *     (เช่น "Root already exists") ทำให้ tx ถัดไปได้ nonce เกิน chain ไป 1 แล้วค้าง
   *     ใน mempool ตลอดกาล · ถ้า getNonce พังครั้งเดียว promise ที่ reject ถูก cache ไว้
   *     ทุก send หลังจากนั้นพังตามจนกว่าจะ restart
   * จึงจัดการ nonce เองใน sendStoreRoot() แทน
   */
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private isReady = false;
  private retryTimer: NodeJS.Timeout | null = null;
  /** เพดานเวลารอ tx confirm — public RPC ช้ากว่า Hardhat มาก ปล่อยรอไม่มีเพดานไม่ได้ */
  private txTimeoutMs = DEFAULT_TX_TIMEOUT_MS;
  /**
   * ส่ง tx ทีละตัว — cron seal กับ cron anchor/reanchor ยิงพร้อมกันทุกนาที
   * ถ้าปล่อยขนานจะถาม nonce ได้เลขเดียวกันแล้วชนกัน (เหตุผลเดิมที่ใส่ NonceManager)
   */
  private sendQueue: Promise<unknown> = Promise.resolve();
  /** nonce ของ tx ล่าสุดที่ส่งสำเร็จ — ใช้กัน RPC ตอบ pending nonce ล้าหลัง */
  private lastSent: { nonce: number; at: number } | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly vaultService: VaultService,
  ) {}

  async onModuleInit() {
    // private key มาจาก Vault ไม่ใช่ .env แล้ว
    const pk = this.vaultService.get().blockchain.privateKey;
    const address = this.configService.get<string>('CONTRACT_ADDRESS');

    // ค่าตั้งต้นของ clone ใหม่ไม่ใช่ "ว่าง": bootstrap ปล่อย BLOCKCHAIN_PRIVATE_KEY=CHANGE_ME
    // (vault-init เก็บลง Vault ตามนั้น) และ .env.example ตั้ง CONTRACT_ADDRESS เป็น zero address
    // ถ้าไม่ดักตรงนี้ new Wallet("CHANGE_ME") โยน error → log ERROR พร้อม stack ทุกครั้งที่
    // เพื่อน clone ไปรัน ทั้งที่ระบบทำงานปกติ (batch เป็น SEALED) — ค่าที่ตั้งจริงแต่ผิดรูปแบบ
    // ยังต้องพังดังเหมือนเดิม จึงดักแค่ placeholder สองแบบนี้
    if (isUnsetPlaceholder(pk) || isUnsetPlaceholder(address)) {
      this.logger.warn(
        'Blockchain not configured — batches stay SEALED (Merkle proof + tamper detection work; ' +
          'roots are not anchored on-chain). Set BLOCKCHAIN_PRIVATE_KEY + CONTRACT_ADDRESS to enable',
      );
      return;
    }

    // มี key + contract แล้ว = ตั้งใจเปิด integrity — RPC หายคือ misconfig
    // fail ตอน boot ดีกว่า fallback ไป 127.0.0.1:8545 เงียบ ๆ
    // แล้วนึกว่า anchor ขึ้น Amoy อยู่ (หลักเดียวกับ buildKafkaSsl)
    const rpcUrl = this.configService.get<string>('BLOCKCHAIN_RPC_URL');
    if (!rpcUrl) {
      throw new Error(
        'BLOCKCHAIN_RPC_URL is required when CONTRACT_ADDRESS is set ' +
          '(e.g. https://polygon-amoy-bor-rpc.publicnode.com)',
      );
    }

    // ethers ไม่ validate address ตอน new Contract() — ถ้าไม่ใช่ hex address
    // มันจะตีเป็น ENS name แล้วไป resolve ตอนเรียก function ครั้งแรก
    // Amoy ไม่รองรับ ENS → reject หลุดออกมาจาก cron เป็น unhandled rejection
    // แล้ว process ตายทีหลัง boot ไปแล้ว (หลักเดียวกับ BLOCKCHAIN_RPC_URL)
    if (!ethers.isAddress(address)) {
      throw new Error(
        `CONTRACT_ADDRESS is not a valid address: "${String(address)}" ` +
          '(expected 0x + 40 hex chars)',
      );
    }

    await this.connect(rpcUrl, pk, address, 1);
  }

  onModuleDestroy() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * ต่อ RPC — พลาดแล้วลองใหม่ไปเรื่อย ๆ แบบ backoff (หลักเดียวกับ Kafka producer)
   *
   * เดิมลองครั้งเดียวตอน boot: RPC สะดุดแค่ครั้งเดียว (เจอจริง: "Client network socket
   * disconnected before secure TLS connection was established") → isReady=false ค้างทั้ง
   * process · batch ค้าง SEALED เงียบ ๆ จนกว่าจะ restart · ต่อติดแล้ว anchorSealedBatches()
   * ตาม anchor ของที่ค้างให้เองในรอบ cron ถัดไป
   */
  private async connect(
    rpcUrl: string,
    pk: string,
    address: string,
    attempt: number,
  ): Promise<void> {
    this.retryTimer = null;
    // provider - เชื่อมกับ RPC node (Hardhat local หรือ Polygon Amoy)
    //
    // ต้องล็อค network ไว้ (staticNetwork) ไม่งั้น ethers จะ re-detect เอง
    // เบื้องหลังทุกครั้งที่ RPC ตอบช้า/พลาด แล้ว error จาก retry loop นั้น
    // ไม่ผูกกับ promise ที่เรา await -> หลุดเป็น uncaught exception ฆ่าทั้ง
    // process (เจอจริงบน public RPC: "failed to detect network ... TIMEOUT")
    // ล็อคแล้ว RPC พลาดจะ reject ในสาย await ปกติ ให้ try/catch ของ
    // sealPendingLogs จัดการ: batch เป็น FAILED แล้วรอบ cron ถัดไป retry
    const probe = new ethers.JsonRpcProvider(rpcUrl);
    try {
      const network = await probe.getNetwork();

      this.provider = new ethers.JsonRpcProvider(rpcUrl, network, {
        staticNetwork: network,
      });
      // wallet - บัญชีใฃ้เซ้น transaction (จ่าย gas)
      this.wallet = new ethers.Wallet(pk, this.provider);
      // contract instance - ผูก address + ABI + wallet
      this.contract = new ethers.Contract(address, CONTRACT_ABI, this.wallet);

      this.txTimeoutMs =
        Number(this.configService.get<string>('BLOCKCHAIN_TX_TIMEOUT_MS')) ||
        DEFAULT_TX_TIMEOUT_MS;

      this.isReady = true;
      this.logger.log(
        `Blockchain connected: ${rpcUrl} contract=${address} txTimeout=${this.txTimeoutMs}ms`,
      );
    } catch (err) {
      const delay = Math.min(
        INIT_RETRY_BASE_MS * 2 ** (attempt - 1),
        INIT_RETRY_MAX_MS,
      );
      this.logger.error(
        `Blockchain init failed (attempt ${attempt}) — retrying in ${delay / 1000}s; ` +
          'batches stay SEALED until connected',
        err,
      );
      this.retryTimer = setTimeout(
        () => void this.connect(rpcUrl, pk, address, attempt + 1),
        delay,
      );
      this.retryTimer.unref();
    } finally {
      // ไม่ destroy ตอนพัง = probe วน detect network ต่อเบื้องหลัง (ปัญหาเดียวกับข้างบน)
      probe.destroy();
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
  async storeRoot(
    batchId: string,
    merkleRoot: string,
  ): Promise<StoreRootResult> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const batchBytes = this.toBytes32(batchId);
    // merkleRoot จาก merkletreejs เป็น '0x...' อยู่แล้ว ใช้ตรงๆ ได้
    const rootBytes = merkleRoot.startsWith('0x')
      ? merkleRoot
      : '0x' + merkleRoot;

    this.logger.log(`Storing root for batch ${batchId}...`);
    const tx = await this.sendStoreRoot(batchBytes, rootBytes);

    // ถึงตรงนี้ tx ถูกส่งขึ้น chain แล้ว — hash ใช้ตามรอยได้เสมอ ต่อให้รอ confirm ไม่ทัน
    try {
      // รอ transaction ถูก mine (confirm) ก่อน — มีเพดานเวลา ไม่รอไม่จำกัด
      const receipt = await tx.wait(1, this.txTimeoutMs);
      // ethers คืน null เฉพาะตอน confirms=0 — ที่นี่ขอ 1 จึงไม่ควรเกิด
      if (!receipt) throw new Error(`tx ${tx.hash} returned no receipt`);
      this.logger.log(
        `Root stored tx=${receipt.hash} block=${receipt.blockNumber}`,
      );
      return {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        confirmed: true,
      };
    } catch (err: any) {
      if (err?.code !== 'TIMEOUT') throw err;

      // tx ส่งไปแล้วแต่ยังไม่ confirm ในเวลาที่กำหนด — ไม่ใช่ความล้มเหลว
      // คืน hash ไปให้ caller บันทึก แล้วให้รอบ verify ถัดไปตามผลเอง
      this.logger.warn(
        `Root tx=${tx.hash} for batch ${batchId} not confirmed within ${this.txTimeoutMs}ms — ` +
          'leaving it for the next verify round',
      );
      return { txHash: tx.hash, blockNumber: null, confirmed: false };
    }
  }

  /**
   * ส่ง storeRoot โดยกำหนด nonce เอง ทีละ tx
   *
   * nonce = max(pending ของ chain, ตัวถัดจากที่เราเพิ่งส่ง) — จำ nonce ไว้ **หลัง** ส่งสำเร็จ
   * เท่านั้น send ที่พังก่อนถึง chain (estimateGas revert / RPC timeout) จึงไม่ทิ้งช่องว่าง
   * และไม่มี state พังค้าง รอบถัดไปถาม chain ใหม่เสมอ
   * ทุก promise อยู่ในสาย await เดียว RPC พลาดจึง reject มาที่ caller ไม่หลุดเป็น uncaught
   */
  private sendStoreRoot(
    batchBytes: string,
    rootBytes: string,
  ): Promise<ethers.ContractTransactionResponse> {
    const send = async () => {
      const pending = await this.wallet.getNonce('pending');
      const hint =
        this.lastSent && Date.now() - this.lastSent.at < NONCE_HINT_TTL_MS
          ? this.lastSent.nonce + 1
          : 0;
      const nonce = Math.max(pending, hint);

      const tx = (await this.contract.storeRoot(batchBytes, rootBytes, {
        nonce,
      })) as ethers.ContractTransactionResponse;
      this.lastSent = { nonce, at: Date.now() };
      return tx;
    };

    // ต่อคิวหลัง send ก่อนหน้า ไม่ว่าตัวก่อนจะสำเร็จหรือพัง
    const run = this.sendQueue.then(send, send);
    this.sendQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * verify ว่า root ที่เก็บไว้ตรงกับที่ส่งมาไหม
   * ถ้าไม่ตรง = ข้อมูลถูก tamper
   */
  async verifyRoot(batchId: string, merkleRoot: string): Promise<boolean> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const batchBytes = this.toBytes32(batchId);
    const rootBytes = merkleRoot.startsWith('0x')
      ? merkleRoot
      : '0x' + merkleRoot;

    return this.contract.verifyRoot(batchBytes, rootBytes);
  }

  /**
   * ดึง root + timestamp ที่เก็บไว้บน chain
   */
  async getRoot(batchId: string): Promise<{ root: string; timestamp: number }> {
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
  ): Promise<{
    result: 'MATCH' | 'MISSING' | 'MISMATCH';
    onChainRoot: string;
  }> {
    if (!this.isReady) throw new Error('Blockchain not ready');

    const { root: onChainRoot } = await this.getRoot(batchId);
    const expected = (
      merkleRooT.startsWith('0x') ? merkleRooT : '0x' + merkleRooT
    ).toLowerCase();

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
    return this.isReady;
  }
}
