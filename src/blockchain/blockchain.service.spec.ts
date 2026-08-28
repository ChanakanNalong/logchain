import { classifyChainError } from './blockchain.service';

/**
 * ethers v6 กระจาย revert string ไว้หลายที่ (reason / shortMessage / revert.args)
 * classifyChainError ต้องจับได้ทุกที่ ไม่งั้น "Root already exists" จะหลุดไปเป็น
 * OTHER แล้ว sealBatch ตั้ง batch เป็น FAILED ทั้งที่ root อยู่บน chain เรียบร้อยแล้ว
 */
describe('classifyChainError', () => {
  it('reads the revert reason from reason', () => {
    expect(classifyChainError({ reason: 'Root already exists' })).toBe('ROOT_EXISTS');
    expect(classifyChainError({ reason: 'Not authorized' })).toBe('NOT_AUTHORIZED');
  });

  it('reads it from shortMessage', () => {
    expect(
      classifyChainError({ shortMessage: 'execution reverted: "Root already exists"' }),
    ).toBe('ROOT_EXISTS');
    expect(
      classifyChainError({ shortMessage: 'execution reverted: "Not authorized"' }),
    ).toBe('NOT_AUTHORIZED');
  });

  it('reads it from revert.args', () => {
    expect(
      classifyChainError({
        code: 'CALL_EXCEPTION',
        revert: { name: 'Error', signature: 'Error(string)', args: ['Root already exists'] },
      }),
    ).toBe('ROOT_EXISTS');
  });

  it('reads it from a plain Error message', () => {
    expect(classifyChainError(new Error('execution reverted: Root already exists'))).toBe(
      'ROOT_EXISTS',
    );
  });

  it('is case-insensitive', () => {
    expect(classifyChainError({ reason: 'ROOT ALREADY EXISTS' })).toBe('ROOT_EXISTS');
  });

  it('falls back to OTHER for anything else', () => {
    expect(classifyChainError(new Error('insufficient funds for gas'))).toBe('OTHER');
    expect(classifyChainError({ code: 'NONCE_EXPIRED' })).toBe('OTHER');
    expect(classifyChainError(undefined)).toBe('OTHER');
    expect(classifyChainError(null)).toBe('OTHER');
    expect(classifyChainError('boom')).toBe('OTHER');
  });
});
