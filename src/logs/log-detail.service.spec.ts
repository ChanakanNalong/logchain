import { NotFoundException } from '@nestjs/common';
import { LogDetailService, CHAIN_CHECK_TIMEOUT_MS } from './log-detail.service';
import { LogService } from './logs.service';
import { IntegrityService } from '../integrity/integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { AlertsService } from '../alerts/alerts.service';

/** GET /logs/:id/detail — sealed / ยังไม่ seal / RPC ล่ม / timeout / ไม่ได้ตั้ง chain / root ไม่ตรง */

const ID = '0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';
const ROOT = 'dfbbcdda5f74f5001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081';

const log = {
  id: ID,
  source: 'web-01',
  sourceIp: '198.51.100.9',
  eventType: 'WEB_REQUEST',
  severity: 'INFO',
  message: 'POST /login 401',
  rawHash: 'ab'.repeat(32),
  classification: 'INTERNAL',
  retentionDays: 365,
  cdeScope: false,
  createdAt: new Date('2026-10-15T09:39:58.004Z'),
};

const batch = {
  id: 'c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c',
  status: 'CONFIRMED',
  merkleRoot: ROOT,
  txHash: '0xfbe0',
  blockNumber: '28451107' as unknown as number, // pg คืน bigint เป็น string
  sealedAt: new Date('2026-10-15T09:40:00.031Z'),
  confirmedAt: new Date('2026-10-15T09:40:06.880Z'),
};

function build(opts: {
  sealed?: boolean;
  ready?: boolean;
  getRoot?: jest.Mock;
}) {
  const logs = {
    findOne: jest.fn((id: string) =>
      id === ID
        ? Promise.resolve(log)
        : Promise.reject(new NotFoundException('Log not found')),
    ),
  } as unknown as LogService;
  const integrity = {
    getProofForLog: jest.fn(() =>
      Promise.resolve(
        opts.sealed === false
          ? null
          : {
              log,
              batch,
              proof: [{ position: 'right', data: '0x5a' }],
              verified: true,
            },
      ),
    ),
  } as unknown as IntegrityService;
  const getRoot =
    opts.getRoot ??
    jest.fn(() =>
      Promise.resolve({ root: '0x' + ROOT.toUpperCase(), timestamp: 1 }),
    );
  const blockchain = {
    ready: opts.ready ?? true,
    getRoot,
  } as unknown as BlockchainService;
  const alerts = {
    findForLog: jest.fn(() => Promise.resolve([{ id: 'a1', role: 'window' }])),
  } as unknown as AlertsService;
  return {
    service: new LogDetailService(logs, integrity, blockchain, alerts),
    getRoot,
  };
}

describe('LogDetailService', () => {
  const env = process.env.BLOCKCHAIN_EXPLORER_TX_URL;
  afterEach(() => {
    if (env === undefined) delete process.env.BLOCKCHAIN_EXPLORER_TX_URL;
    else process.env.BLOCKCHAIN_EXPLORER_TX_URL = env;
    jest.useRealTimers();
  });

  it('sealed + anchored: batch, proof, alerts and a matching chainCheck', async () => {
    delete process.env.BLOCKCHAIN_EXPLORER_TX_URL;
    const { service, getRoot } = build({});
    const d = await service.getDetail(ID);

    expect(d.log).toEqual({
      id: ID,
      createdAt: log.createdAt,
      source: 'web-01',
      sourceIp: '198.51.100.9',
      eventType: 'WEB_REQUEST',
      severity: 'INFO',
      message: 'POST /login 401',
      classification: 'INTERNAL',
      cdeScope: false,
      retentionDays: 365,
      rawHash: 'ab'.repeat(32),
    });
    expect(d.batch).toEqual({
      id: batch.id,
      status: 'CONFIRMED',
      merkleRoot: ROOT,
      txHash: '0xfbe0',
      blockNumber: 28451107,
      polygonscanUrl: 'https://amoy.polygonscan.com/tx/0xfbe0',
      sealedAt: batch.sealedAt,
      confirmedAt: batch.confirmedAt,
    });
    expect(d.proof).toEqual({
      verified: true,
      path: [{ position: 'right', data: '0x5a' }],
    });
    expect(d.alerts).toEqual([{ id: 'a1', role: 'window' }]);
    expect(d.chainCheck).toMatchObject({
      chainRoot: '0x' + ROOT,
      dbRoot: '0x' + ROOT,
      match: true,
    });
    expect(getRoot).toHaveBeenCalledWith(batch.id);
  });

  it('explorer can be switched off (Hardhat) → polygonscanUrl null', async () => {
    process.env.BLOCKCHAIN_EXPLORER_TX_URL = '';
    const d = await build({}).service.getDetail(ID);
    expect(d.batch?.polygonscanUrl).toBeNull();
  });

  it('not sealed yet: batch, proof and chainCheck are null, no chain call', async () => {
    const { service, getRoot } = build({ sealed: false });
    const d = await service.getDetail(ID);
    expect(d.batch).toBeNull();
    expect(d.proof).toBeNull();
    expect(d.chainCheck).toBeNull();
    expect(d.alerts).toHaveLength(1);
    expect(getRoot).not.toHaveBeenCalled();
  });

  it('RPC down: chainCheck carries the error instead of throwing', async () => {
    const getRoot = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const d = await build({ getRoot }).service.getDetail(ID);
    expect(d.batch).not.toBeNull();
    expect(d.chainCheck).toMatchObject({
      error: 'could not read root from chain: ECONNREFUSED',
    });
    expect(d.chainCheck).not.toHaveProperty('match');
  });

  it('RPC hangs: gives up after CHAIN_CHECK_TIMEOUT_MS', async () => {
    jest.useFakeTimers();
    const getRoot = jest.fn(() => new Promise(() => undefined));
    const pending = build({ getRoot }).service.getDetail(ID);
    await jest.advanceTimersByTimeAsync(CHAIN_CHECK_TIMEOUT_MS + 1);
    const d = await pending;
    expect(d.chainCheck).toMatchObject({
      error: expect.stringContaining(
        `timed out after ${CHAIN_CHECK_TIMEOUT_MS}ms`,
      ),
    });
  });

  it('chain not configured: error, not a fake mismatch', async () => {
    const d = await build({ ready: false }).service.getDetail(ID);
    expect(d.chainCheck).toMatchObject({ error: 'Blockchain not configured' });
  });

  it('no root on chain (zero) or a different root → match false', async () => {
    const zero = '0x' + '0'.repeat(64);
    const getRoot = jest.fn(() =>
      Promise.resolve({ root: zero, timestamp: 0 }),
    );
    const d = await build({ getRoot }).service.getDetail(ID);
    expect(d.chainCheck).toMatchObject({ chainRoot: zero, match: false });
  });

  it('unknown log → 404', async () => {
    await expect(
      build({}).service.getDetail('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
