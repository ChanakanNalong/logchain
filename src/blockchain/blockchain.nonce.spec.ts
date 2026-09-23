import * as http from 'http';
import { AddressInfo } from 'net';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { BlockchainService } from './blockchain.service';
import { VaultService } from '../vault/vault.service';

/**
 * บั๊กที่เทสนี้คุม (ethers.NonceManager 6.17 — เลิกใช้แล้ว):
 *  1. RPC timeout ระหว่างถาม nonce → unhandled rejection ฆ่าทั้ง process
 *     (เจอจริง: backend restart หลัง "Anchor batch ... ไม่สำเร็จ: request timeout")
 *  2. send ที่พังก่อนถึง chain (estimateGas revert) ยังนับ nonce +1 → tx ถัดไปค้าง mempool
 *  3. ถาม nonce พังครั้งเดียว → promise ที่ reject ถูก cache ไว้ ทุก send หลังจากนั้นพัง
 *
 * ใช้ ethers ของจริงยิงเข้า JSON-RPC server ปลอม ไม่ mock ethers
 * เพราะบั๊กอยู่ในพฤติกรรมของ library เอง mock ไปก็จับไม่ได้
 */

const CHAIN_NONCE = 5;
const BLOCK = {
  number: '0x10',
  hash: '0x' + '11'.repeat(32),
  parentHash: '0x' + '22'.repeat(32),
  timestamp: '0x1',
  nonce: '0x0000000000000000',
  difficulty: '0x0',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  miner: '0x' + '00'.repeat(20),
  extraData: '0x',
  baseFeePerGas: '0x7',
  transactions: [],
};

type RpcCall = { id: number; method: string; params: unknown[] };
/** คืน undefined = ตอบค่าปกติ · 'DROP' = ตอบ 502 ทั้ง batch (เหมือน RPC timeout) · { error } = JSON-RPC error · { result } = ตอบค่านี้แทน */
type JsonRpcError = { code: number; message: string };
type Override = (
  call: RpcCall,
) => undefined | 'DROP' | { error: JsonRpcError } | { result: unknown };

describe('BlockchainService — nonce handling', () => {
  let server: http.Server;
  let url: string;
  let override: Override;
  let sentNonces: number[];
  let unhandled: unknown[];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  let svc: BlockchainService;

  function answer(call: RpcCall): unknown {
    switch (call.method) {
      case 'eth_chainId':
        return '0x13882';
      case 'eth_getTransactionCount':
        return ethers.toQuantity(CHAIN_NONCE);
      case 'eth_estimateGas':
        return '0x5208';
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return '0x3b9aca00';
      case 'eth_blockNumber':
        return '0x10';
      case 'eth_getBlockByNumber':
        return BLOCK;
      case 'eth_sendRawTransaction': {
        const raw = call.params[0] as string;
        sentNonces.push(ethers.Transaction.from(raw).nonce);
        return ethers.keccak256(raw);
      }
      default:
        return null; // receipt / tx ยังไม่มี
    }
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed: unknown = JSON.parse(body);
        const calls: RpcCall[] = (
          Array.isArray(parsed) ? parsed : [parsed]
        ) as RpcCall[];
        const results: unknown[] = [];
        for (const call of calls) {
          const o = override(call);
          if (o === 'DROP') {
            // ทั้ง batch พังด้วย error ก้อนเดียวกัน แบบเดียวกับ RPC timeout
            // (ไม่ใช้ socket.destroy — keep-alive ของ http agent ชนกันเองจนเทสเพี้ยน)
            res.statusCode = 502;
            res.end();
            return;
          }
          results.push(
            o && 'error' in o
              ? { jsonrpc: '2.0', id: call.id, error: o.error }
              : {
                  jsonrpc: '2.0',
                  id: call.id,
                  result: o ? o.result : answer(call),
                },
          );
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(parsed) ? results : results[0]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise((r) => server.close(r)));

  beforeEach(async () => {
    override = () => undefined;
    sentNonces = [];
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const env: Record<string, string> = {
      CONTRACT_ADDRESS: '0x' + '44'.repeat(20),
      BLOCKCHAIN_RPC_URL: url,
      BLOCKCHAIN_TX_TIMEOUT_MS: '20', // ไม่รอ confirm จริง — คืน confirmed=false
    };
    const cfg = { get: (k: string) => env[k] } as unknown as ConfigService;
    const vault = {
      get: () => ({ blockchain: { privateKey: '0x' + '01'.repeat(32) } }),
    } as unknown as VaultService;
    svc = new BlockchainService(cfg, vault);
    await svc.onModuleInit();
    expect(svc.ready).toBe(true);
  });

  afterEach(async () => {
    (
      svc as unknown as { provider?: { destroy: () => void } }
    ).provider?.destroy();
    // ให้ rejection ที่หลุดมีเวลาโผล่ก่อนถอด listener
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    jest.restoreAllMocks();
  });

  const store = (id: string) => svc.storeRoot(id, '0x' + '55'.repeat(32));

  it('RPC หลุดตอนถาม nonce — reject มาที่ caller ไม่หลุดเป็น unhandled rejection', async () => {
    override = (c) =>
      c.method === 'eth_getTransactionCount' ? 'DROP' : undefined;

    await expect(store('b1')).rejects.toBeDefined();
    await new Promise((r) => setTimeout(r, 50));

    expect(unhandled).toEqual([]);
  });

  it('ถาม nonce พังครั้งเดียว — send ถัดไปยังส่งได้ (ไม่ cache ความล้มเหลวไว้)', async () => {
    let failOnce = true;
    override = (c) => {
      if (c.method === 'eth_getTransactionCount' && failOnce) {
        failOnce = false;
        return 'DROP';
      }
      return undefined;
    };

    await expect(store('b1')).rejects.toBeDefined();
    // ethers เก็บผลของ request ที่เหมือนกันไว้ 250ms (รวม reject) — cron จริงห่างกัน 1 นาที
    // ที่เทสนี้ต้องคุมคือ "ค้างถาวร" แบบ NonceManager ไม่ใช่ cache สั้น ๆ ของ provider
    await new Promise((r) => setTimeout(r, 300));
    await expect(store('b2')).resolves.toMatchObject({ confirmed: false });

    expect(sentNonces).toEqual([CHAIN_NONCE]);
  });

  it('estimateGas revert ("Root already exists") — ไม่ทิ้งช่องว่าง tx ถัดไปได้ nonce ของ chain', async () => {
    let revertOnce = true;
    override = (c) => {
      if (c.method === 'eth_estimateGas' && revertOnce) {
        revertOnce = false;
        return {
          error: {
            code: 3,
            message: 'execution reverted: Root already exists',
          },
        };
      }
      return undefined;
    };

    await expect(store('b1')).rejects.toBeDefined();
    await store('b2');

    // NonceManager เดิมส่ง 6 ตรงนี้ → ค้าง mempool ตลอดกาล
    expect(sentNonces).toEqual([CHAIN_NONCE]);
  });

  it('รอ confirm ครบเพดาน — log บอกว่า "not confirmed within" (TIMEOUT จริงของ ethers)', async () => {
    const warn = Logger.prototype.warn as jest.Mock;

    await expect(store('b1')).resolves.toMatchObject({ confirmed: false });

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not confirmed within 20ms'),
    );
  });

  it('RPC timeout ระหว่างรอ receipt — log บอกว่าเป็น RPC ไม่ใช่ chain ช้า', async () => {
    const warn = Logger.prototype.warn as jest.Mock;
    jest
      .spyOn(ethers.ContractTransactionResponse.prototype, 'wait')
      .mockRejectedValueOnce(
        ethers.makeError('timeout', 'TIMEOUT', {
          operation: 'request.send',
          reason: 'timeout',
          request: new ethers.FetchRequest(url),
        }),
      );

    await expect(store('b1')).resolves.toMatchObject({ confirmed: false });

    const msg = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(msg).toContain('RPC timed out while waiting for the receipt');
    expect(msg).not.toContain('not confirmed within');
  });

  it('RPC พังแบบอื่น (502) ระหว่างถาม receipt — tx ส่งไปแล้ว คืน confirmed:false ไม่โยน (เดิมกลายเป็น FAILED)', async () => {
    const warn = Logger.prototype.warn as jest.Mock;
    override = (c) =>
      c.method === 'eth_getTransactionReceipt' ? 'DROP' : undefined;

    await expect(store('b1')).resolves.toMatchObject({
      confirmed: false,
      blockNumber: null,
    });

    expect(sentNonces).toEqual([CHAIN_NONCE]);
    const msg = (warn.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .join('\n');
    expect(msg).toContain('RPC error while waiting for the receipt');
  });

  it('tx ลง chain แต่ revert (receipt status 0) — รู้ผลแล้ว ต้องโยนให้ caller ตั้ง FAILED', async () => {
    override = (c) =>
      c.method === 'eth_getTransactionReceipt'
        ? {
            result: {
              transactionHash: c.params[0],
              blockHash: '0x' + '33'.repeat(32),
              blockNumber: '0x10',
              transactionIndex: '0x0',
              from: new ethers.Wallet('0x' + '01'.repeat(32)).address,
              to: '0x' + '44'.repeat(20),
              contractAddress: null,
              cumulativeGasUsed: '0x5208',
              gasUsed: '0x5208',
              effectiveGasPrice: '0x3b9aca00',
              logs: [],
              logsBloom: '0x' + '00'.repeat(256),
              status: '0x0',
              type: '0x2',
            },
          }
        : undefined;

    await expect(store('b1')).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
    });
  });

  it('error ที่ไม่ใช่ของ ethers ระหว่างรอ (บั๊กในโค้ด) — โยนต่อ ไม่กลบเป็น "ยังไม่ confirm"', async () => {
    jest
      .spyOn(ethers.ContractTransactionResponse.prototype, 'wait')
      .mockRejectedValueOnce(new TypeError('bug'));

    await expect(store('b1')).rejects.toThrow(TypeError);
  });

  it('ยิงพร้อมกันสองตัว (cron seal + cron anchor) — ได้ nonce ไม่ชนกัน แม้ RPC ตอบ pending ล้าหลัง', async () => {
    // server ตอบ pending = 5 ตลอด (เหมือน node ที่ยังไม่เห็น tx ที่เพิ่งส่ง)
    await Promise.all([store('b1'), store('b2')]);

    expect(sentNonces).toEqual([CHAIN_NONCE, CHAIN_NONCE + 1]);
  });
});
