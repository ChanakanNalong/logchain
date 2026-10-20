import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { BatchTreeService } from './batch-tree.service';
import { MerkleService } from './service/merkle.service';
import { IntegrityService } from './integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { Batch } from '../logs/entities/batch.entity';
import { Log } from '../logs/entities/log.entity';

/** GET /batches/:id/tree — layers / promoted / roots / cost (MerkleService ตัวจริง) */

const BATCH = 'c2b2b2a7-1d3e-4f5a-9b8c-7d6e5f4a3b2c';
const merkle = new MerkleService();
const raw = (i: number) => createHash('sha256').update(`log${i}`).digest('hex');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function build(n: number, batchPatch: Partial<Batch> = {}, chain?: jest.Mock) {
  // raw_hash = raw(i) (ตามเดิม) + ใส่ field เนื้อหาให้ครบเพื่อให้ recomputeContentLeaf (contentRoot) ไม่ crash
  const logs = Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `log-${i}`,
        source: 'unit',
        sourceIp: null,
        eventType: 'E',
        severity: 'INFO',
        message: `m${i}`,
        classification: 'INTERNAL',
        cdeScope: false,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        rawHash: raw(i),
      }) as Log,
  );
  const root = merkle.buildTree(logs.map((l) => l.rawHash)).root;
  const batch = {
    id: BATCH,
    status: 'CONFIRMED',
    logCount: n,
    merkleRoot: root.replace(/^0x/, ''),
    txHash: '0xabc',
    blockNumber: '7' as unknown as number,
    gasUsed: null,
    effectiveGasPrice: null,
    ...batchPatch,
  } as Batch;
  const getRoot =
    chain ?? jest.fn(() => Promise.resolve({ root, timestamp: 1 }));
  const service = new BatchTreeService(
    {
      findOneBy: ({ id }: { id: string }) =>
        Promise.resolve(id === BATCH ? batch : null),
      // batch-tree โหลด snapshot ผ่าน manager — ชุดทดสอบนี้ไม่มี snapshot (snapshotRoot = null)
      manager: {
        getRepository: () => ({ find: () => Promise.resolve([]) }),
      },
    } as unknown as Repository<Batch>,
    merkle,
    {
      getLogsForBatch: () => Promise.resolve(logs),
    } as unknown as IntegrityService,
    { ready: true, getRoot } as unknown as BlockchainService,
  );
  return { service, root, logs };
}

/** root ประกอบเองจาก layers + promoted ตามกติกา sortPairs — ต้องได้ root เดียวกับ merkletreejs */
function rootFromLayers(layers: string[][]): string {
  return layers[layers.length - 1][0];
}

describe('BatchTreeService', () => {
  const env = { ...process.env };
  afterEach(() => {
    for (const k of [
      'PRICE_POL_ETH',
      'PRICE_POL_THB',
      'PRICE_AS_OF',
      'BLOCKCHAIN_EXPLORER_TX_URL',
    ]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it.each([1, 2, 3, 5, 7, 100])(
    '%d logs: last layer is the DB root, layer 0 = leafHashes',
    async (n) => {
      const { service, root, logs } = build(n);
      const t = await service.tree(BATCH);
      expect(rootFromLayers(t.layers)).toBe(root);
      expect(t.storedHashRoot).toBe(root);
      expect(t.storedHashRootMatchesDb).toBe(true);
      expect(t.layers[0]).toEqual(logs.map((l) => '0x' + sha(l.rawHash)));
      expect(t.leaves.map((l) => l.index)).toEqual(logs.map((_, i) => i));
      expect(t.leaves[0]).toMatchObject({
        index: 0,
        logId: 'log-0',
        rawHash: raw(0),
        leafHash: '0x' + sha(raw(0)),
      });
      // ทุกชั้นถัดไป = ceil(ครึ่งหนึ่ง)
      for (let l = 1; l < t.layers.length; l++) {
        expect(t.layers[l]).toHaveLength(Math.ceil(t.layers[l - 1].length / 2));
      }
    },
  );

  it('1 log: single layer, root = leafHash, nothing promoted', async () => {
    const t = await build(1).service.tree(BATCH);
    expect(t.layers).toHaveLength(1);
    expect(t.layers[0][0]).toBe(t.leaves[0].leafHash);
    expect(t.promoted).toEqual([]);
  });

  it('odd counts: promoted nodes are copied up unchanged', async () => {
    const t = await build(5).service.tree(BATCH);
    expect(t.promoted).toEqual([
      { layer: 0, index: 4 },
      { layer: 1, index: 2 },
    ]);
    for (const p of t.promoted) {
      expect(t.layers[p.layer + 1][Math.floor(p.index / 2)]).toBe(
        t.layers[p.layer][p.index],
      );
    }
    // คู่ปกติ = sha256(เรียงคู่แล้วต่อกัน)
    const [a, b] = [t.layers[0][0], t.layers[0][1]]
      .map((h) => Buffer.from(h.slice(2), 'hex'))
      .sort(Buffer.compare);
    expect(t.layers[1][0]).toBe(
      '0x' +
        createHash('sha256')
          .update(Buffer.concat([a, b]))
          .digest('hex'),
    );
  });

  it('100 logs: 7 layers, promoted where a layer is odd', async () => {
    const t = await build(100).service.tree(BATCH);
    expect(t.layers.map((l) => l.length)).toEqual([
      100, 50, 25, 13, 7, 4, 2, 1,
    ]);
    expect(t.promoted).toEqual([
      { layer: 2, index: 24 },
      { layer: 3, index: 12 },
      { layer: 4, index: 6 },
    ]);
  });

  it('no gas_used → cost null', async () => {
    const t = await build(3).service.tree(BATCH);
    expect(t.cost).toBeNull();
  });

  it('cost as exact decimal strings, ETH/THB from configured rates', async () => {
    process.env.PRICE_POL_ETH = '0.0000625';
    process.env.PRICE_POL_THB = '7.85';
    process.env.PRICE_AS_OF = '2026-10-15';
    const t = await build(5, {
      gasUsed: '78156',
      effectiveGasPrice: '50000000000',
    }).service.tree(BATCH);
    expect(t.cost).toEqual({
      gasUsed: '78156',
      effectiveGasPriceGwei: '50',
      batchCostPol: '0.0039078',
      perLogCostPol: '0.00078156',
      oneTxPerLogCostPol: '0.019539',
      savingFactor: '5',
      eth: {
        batch: '0.0000002442375',
        perLog: '0.0000000488475',
        oneTxPerLog: '0.0000012211875',
      },
      thb: {
        batch: '0.03067623',
        perLog: '0.006135246',
        oneTxPerLog: '0.15338115',
      },
      rates: {
        polEth: '0.0000625',
        polThb: '7.85',
        asOf: '2026-10-15',
        source: 'config',
      },
    });
  });

  it('rates not configured (or invalid) → eth/thb null, POL still there', async () => {
    delete process.env.PRICE_POL_ETH;
    process.env.PRICE_POL_THB = '1e-7';
    const t = await build(2, {
      gasUsed: '78156',
      effectiveGasPrice: '25000000063',
    }).service.tree(BATCH);
    expect(t.cost?.eth).toBeNull();
    expect(t.cost?.thb).toBeNull();
    expect(t.cost?.rates).toEqual({
      polEth: null,
      polThb: null,
      asOf: null,
      source: 'config',
    });
    expect(t.cost?.effectiveGasPriceGwei).toBe('25.000000063');
    expect(t.cost?.batchCostPol).toBe('0.001953900004923828');
  });

  it('RPC down: chainRoot null + chainError, tree still built', async () => {
    const getRoot = jest.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const t = await build(3, {}, getRoot).service.tree(BATCH);
    expect(t.chainRoot).toBeNull();
    expect(t.chainError).toContain('ECONNREFUSED');
    expect(t.storedHashRootMatchesDb).toBe(true);
  });

  it('a tampered raw_hash shows as rootMatchesDb false', async () => {
    const { service } = build(3, { merkleRoot: 'a'.repeat(64) });
    const t = await service.tree(BATCH);
    expect(t.storedHashRootMatchesDb).toBe(false);
    expect(t.dbRoot).toBe('0x' + 'a'.repeat(64));
  });

  it('polygonscanUrl follows BLOCKCHAIN_EXPLORER_TX_URL; blockNumber is a number', async () => {
    process.env.BLOCKCHAIN_EXPLORER_TX_URL = '';
    const t = await build(1).service.tree(BATCH);
    expect(t.polygonscanUrl).toBeNull();
    expect(t.blockNumber).toBe(7);
  });

  it('404 for an unknown batch', async () => {
    await expect(
      build(1).service.tree('11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
