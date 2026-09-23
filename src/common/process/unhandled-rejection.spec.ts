import { Logger } from '@nestjs/common';
import { ethers } from 'ethers';
import {
  installUnhandledRejectionGuard,
  isEthersError,
} from './unhandled-rejection';

describe('isEthersError', () => {
  it('accepts real ethers errors', () => {
    expect(isEthersError(ethers.makeError('request timeout', 'TIMEOUT'))).toBe(
      true,
    );
    expect(
      isEthersError(ethers.makeError('network down', 'NETWORK_ERROR')),
    ).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isEthersError(new Error('boom'))).toBe(false);
    // error ของ Node มี code แต่ไม่มี shortMessage
    expect(
      isEthersError(
        Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      ),
    ).toBe(false);
    expect(isEthersError({ shortMessage: 'x' })).toBe(false);
    expect(isEthersError({ code: 1, shortMessage: 'x' })).toBe(false);
    expect(isEthersError(null)).toBe(false);
    expect(isEthersError(undefined)).toBe(false);
    expect(isEthersError('TIMEOUT')).toBe(false);
  });
});

describe('installUnhandledRejectionGuard', () => {
  let uninstall: () => void;
  let handler: (reason: unknown) => void;
  let onEthers: jest.Mock;
  let logger: Logger;

  beforeEach(() => {
    const before = process.listeners('unhandledRejection');
    onEthers = jest.fn();
    logger = new Logger('test');
    jest.spyOn(logger, 'error').mockImplementation();
    uninstall = installUnhandledRejectionGuard(onEthers, logger);
    handler = process
      .listeners('unhandledRejection')
      .find((l) => !before.includes(l)) as (reason: unknown) => void;
  });
  afterEach(() => {
    uninstall();
    jest.restoreAllMocks();
  });

  it('keeps the process alive on an ethers error: logs ERROR and counts it', () => {
    const err = ethers.makeError('request timeout', 'TIMEOUT');

    expect(() => handler(err)).not.toThrow();
    expect(onEthers).toHaveBeenCalledWith('TIMEOUT');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('TIMEOUT'),
      expect.any(String),
    );
  });

  it.each([
    ['plain Error', new Error('real bug')],
    ['Node error with code', Object.assign(new Error('x'), { code: 'EPIPE' })],
    ['string', 'oops'],
    ['undefined', undefined],
  ])('rethrows a non-ethers rejection (%s) so Node still dies', (_, reason) => {
    expect(() => handler(reason)).toThrow();
    expect(onEthers).not.toHaveBeenCalled();
  });

  it('uninstall removes the handler', () => {
    uninstall();
    expect(process.listeners('unhandledRejection')).not.toContain(handler);
  });
});
