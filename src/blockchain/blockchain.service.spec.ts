import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import {
  BlockchainService,
  classifyChainError,
  INIT_RETRY_BASE_MS,
  isWaitDeadline,
} from './blockchain.service';
import { VaultService } from '../vault/vault.service';

/**
 * ethers v6 กระจาย revert string ไว้หลายที่ (reason / shortMessage / revert.args)
 * classifyChainError ต้องจับได้ทุกที่ ไม่งั้น "Root already exists" จะหลุดไปเป็น
 * OTHER แล้ว sealBatch ตั้ง batch เป็น FAILED ทั้งที่ root อยู่บน chain เรียบร้อยแล้ว
 */
describe('classifyChainError', () => {
  it('reads the revert reason from reason', () => {
    expect(classifyChainError({ reason: 'Root already exists' })).toBe(
      'ROOT_EXISTS',
    );
    expect(classifyChainError({ reason: 'Not authorized' })).toBe(
      'NOT_AUTHORIZED',
    );
  });

  it('reads it from shortMessage', () => {
    expect(
      classifyChainError({
        shortMessage: 'execution reverted: "Root already exists"',
      }),
    ).toBe('ROOT_EXISTS');
    expect(
      classifyChainError({
        shortMessage: 'execution reverted: "Not authorized"',
      }),
    ).toBe('NOT_AUTHORIZED');
  });

  it('reads it from revert.args', () => {
    expect(
      classifyChainError({
        code: 'CALL_EXCEPTION',
        revert: {
          name: 'Error',
          signature: 'Error(string)',
          args: ['Root already exists'],
        },
      }),
    ).toBe('ROOT_EXISTS');
  });

  it('reads it from a plain Error message', () => {
    expect(
      classifyChainError(new Error('execution reverted: Root already exists')),
    ).toBe('ROOT_EXISTS');
  });

  it('is case-insensitive', () => {
    expect(classifyChainError({ reason: 'ROOT ALREADY EXISTS' })).toBe(
      'ROOT_EXISTS',
    );
  });

  it('falls back to OTHER for anything else', () => {
    expect(classifyChainError(new Error('insufficient funds for gas'))).toBe(
      'OTHER',
    );
    expect(classifyChainError({ code: 'NONCE_EXPIRED' })).toBe('OTHER');
    expect(classifyChainError(undefined)).toBe('OTHER');
    expect(classifyChainError(null)).toBe('OTHER');
    expect(classifyChainError('boom')).toBe('OTHER');
  });
});

/**
 * clone ใหม่ + bootstrap.sh ได้ BLOCKCHAIN_PRIVATE_KEY=CHANGE_ME และ CONTRACT_ADDRESS=zero address
 * เดิมผ่านเช็ค "ตั้งค่าแล้ว" ไปพังที่ new Wallet() → ERROR + stack ทุกครั้งที่เพื่อน clone ไปรัน
 */
describe('BlockchainService.onModuleInit — unconfigured placeholders', () => {
  function make(pk: string, address: string) {
    const cfg = {
      get: (k: string) =>
        ({
          CONTRACT_ADDRESS: address,
          BLOCKCHAIN_RPC_URL: 'http://127.0.0.1:1',
        })[k],
    } as unknown as ConfigService;
    const vault = {
      get: () => ({ blockchain: { privateKey: pk } }),
    } as unknown as VaultService;
    return new BlockchainService(cfg, vault);
  }

  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['CHANGE_ME', '0x0000000000000000000000000000000000000000'], // ค่าจาก bootstrap จริง
    ['CHANGE_ME', '0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5'],
    ['0x' + '01'.repeat(32), '0x0000000000000000000000000000000000000000'],
    ['', '0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5'],
  ])(
    'pk=%p address=%p → not configured: warn only, no ERROR',
    async (pk, addr) => {
      const svc = make(pk, addr);
      await svc.onModuleInit();

      expect(svc.ready).toBe(false);
      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Blockchain not configured'),
      );
    },
  );
});

/**
 * RPC สะดุดตอน boot ครั้งเดียว (เจอจริง: TLS หลุด) เดิมทำให้ isReady=false ทั้ง process
 * batch ค้าง SEALED เงียบ ๆ จนกว่าจะ restart — ต้องลองใหม่เองจนต่อติด
 */
describe('BlockchainService.onModuleInit — RPC unavailable at boot', () => {
  const PK = '0x' + '01'.repeat(32);
  const ADDR = '0x5dC86975615d3bc713cdf9f25ad1cA25CE7949f5';

  function make() {
    const cfg = {
      get: (k: string) =>
        ({
          CONTRACT_ADDRESS: ADDR,
          BLOCKCHAIN_RPC_URL: 'http://127.0.0.1:1',
        })[k],
    } as unknown as ConfigService;
    const vault = {
      get: () => ({ blockchain: { privateKey: PK } }),
    } as unknown as VaultService;
    return new BlockchainService(cfg, vault);
  }

  let getNetwork: jest.SpyInstance;
  let destroy: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    getNetwork = jest.spyOn(ethers.JsonRpcProvider.prototype, 'getNetwork');
    destroy = jest.spyOn(ethers.JsonRpcProvider.prototype, 'destroy');
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('retries after a failed connect and becomes ready', async () => {
    getNetwork
      .mockRejectedValueOnce(new Error('socket disconnected before TLS'))
      .mockResolvedValueOnce(ethers.Network.from(80002));
    const svc = make();

    await svc.onModuleInit();
    expect(svc.ready).toBe(false);
    // probe ที่พังต้องถูกปิด ไม่งั้นวน detect network ต่อเบื้องหลัง
    expect(destroy).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(INIT_RETRY_BASE_MS);
    expect(getNetwork).toHaveBeenCalledTimes(2);
    expect(svc.ready).toBe(true);
    svc.onModuleDestroy();
  });

  it('backs off between attempts and stops retrying on destroy', async () => {
    getNetwork.mockRejectedValue(new Error('down'));
    const svc = make();

    await svc.onModuleInit();
    await jest.advanceTimersByTimeAsync(INIT_RETRY_BASE_MS);
    expect(getNetwork).toHaveBeenCalledTimes(2);
    // ครั้งถัดไปรอ 2 เท่า — ยังไม่ถึงเวลา
    await jest.advanceTimersByTimeAsync(INIT_RETRY_BASE_MS);
    expect(getNetwork).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(INIT_RETRY_BASE_MS);
    expect(getNetwork).toHaveBeenCalledTimes(3);

    svc.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(10 * INIT_RETRY_BASE_MS);
    expect(getNetwork).toHaveBeenCalledTimes(3);
    expect(svc.ready).toBe(false);
  });
});

/**
 * ethers ใช้ code TIMEOUT ทั้งรอ confirm ครบเพดาน และ RPC ไม่ตอบ — shape ตาม source ของ 6.17
 */
describe('isWaitDeadline', () => {
  it('true only for the tx.wait deadline', () => {
    expect(
      isWaitDeadline(
        ethers.makeError('wait for transaction timeout', 'TIMEOUT'),
      ),
    ).toBe(true);
  });

  it('false for RPC timeouts and anything else', () => {
    // utils/fetch.js
    expect(
      isWaitDeadline(
        ethers.makeError('timeout', 'TIMEOUT', {
          operation: 'request.send',
          reason: 'timeout',
          request: new ethers.FetchRequest('http://x'),
        }),
      ),
    ).toBe(false);
    // utils/geturl.js
    expect(isWaitDeadline(ethers.makeError('request timeout', 'TIMEOUT'))).toBe(
      false,
    );
    // providers/abstract-provider.js (waitForBlock)
    expect(
      isWaitDeadline(
        ethers.makeError('timeout', 'TIMEOUT', {
          reason: 'timeout',
        } as never),
      ),
    ).toBe(false);
    expect(isWaitDeadline(new Error('wait for transaction timeout'))).toBe(
      false,
    );
    expect(isWaitDeadline(null)).toBe(false);
  });
});
