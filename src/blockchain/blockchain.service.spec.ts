import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlockchainService, classifyChainError } from './blockchain.service';
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
