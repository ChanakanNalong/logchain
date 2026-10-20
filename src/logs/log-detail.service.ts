import { Injectable, Logger } from '@nestjs/common';
import { LogService } from './logs.service';
import { IntegrityService } from '../integrity/integrity.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { AlertsService, LogAlertView } from '../alerts/alerts.service';
import { explorerTxUrl } from '../blockchain/explorer';
import { CHAIN_READ_TIMEOUT_MS, readChainRoot } from '../blockchain/chain-read';

/** เพดานเวลาอ่าน root จาก chain (ดู readChainRoot) */
export const CHAIN_CHECK_TIMEOUT_MS = CHAIN_READ_TIMEOUT_MS;

export type ChainCheck =
  | { chainRoot: string; dbRoot: string; match: boolean; checkedAt: Date }
  | { error: string; checkedAt: Date };

export interface LogDetail {
  log: {
    id: string;
    createdAt: Date;
    source: string;
    sourceIp: string | null;
    eventType: string;
    severity: string;
    message: string;
    classification: string;
    cdeScope: boolean;
    retentionDays: number;
    rawHash: string;
  };
  batch: {
    id: string;
    status: string;
    merkleRoot: string;
    txHash: string | null;
    blockNumber: number | null;
    polygonscanUrl: string | null;
    sealedAt: Date;
    confirmedAt: Date | null;
  } | null;
  proof: {
    /** null = ตรวจ proof กับเชนไม่ได้ (อ่านเชนไม่ได้/ยังไม่ anchor) */
    verified: boolean | null;
    path: Array<{ position: string; data: string }>;
  } | null;
  alerts: LogAlertView[];
  /** null = ยังไม่ seal (ไม่มี root ให้เทียบ) */
  chainCheck: ChainCheck | null;
}

/**
 * GET /logs/:id/detail — ทุกอย่างของ log ตัวเดียวในคำขอเดียว (หน้า detail ของ frontend)
 * สัญญา JSON: docs/api/logs-alerts.md ข้อ 3
 */
@Injectable()
export class LogDetailService {
  private readonly logger = new Logger(LogDetailService.name);

  constructor(
    private readonly logs: LogService,
    private readonly integrity: IntegrityService,
    private readonly blockchain: BlockchainService,
    private readonly alerts: AlertsService,
  ) {}

  async getDetail(id: string): Promise<LogDetail> {
    const log = await this.logs.findOne(id); // 404 ถ้าไม่มี
    const [sealed, alerts] = await Promise.all([
      this.integrity.getProofForLog(id),
      this.alerts.findForLog(id),
    ]);

    const detail: LogDetail = {
      log: {
        id: log.id,
        createdAt: log.createdAt,
        source: log.source,
        sourceIp: log.sourceIp,
        eventType: log.eventType,
        severity: log.severity,
        message: log.message,
        classification: log.classification,
        cdeScope: log.cdeScope,
        retentionDays: log.retentionDays,
        rawHash: log.rawHash,
      },
      batch: null,
      proof: null,
      alerts,
      chainCheck: null,
    };
    if (!sealed) return detail;

    const { batch } = sealed;
    detail.batch = {
      id: batch.id,
      status: batch.status,
      merkleRoot: batch.merkleRoot,
      txHash: batch.txHash ?? null,
      blockNumber:
        batch.blockNumber === null ? null : Number(batch.blockNumber),
      polygonscanUrl: explorerTxUrl(batch.txHash),
      sealedAt: batch.sealedAt,
      confirmedAt: batch.confirmedAt,
    };
    detail.proof = { verified: sealed.verified, path: sealed.proof };
    detail.chainCheck = await this.checkChain(batch.id, batch.merkleRoot);
    return detail;
  }

  /** root บน chain (eth_call) เทียบกับ DB — พังแบบไหนก็คืน { error } ไม่ใช่ 500 */
  private async checkChain(
    batchId: string,
    merkleRoot: string,
  ): Promise<ChainCheck> {
    const dbRoot = ('0x' + merkleRoot.replace(/^0x/, '')).toLowerCase();
    const read = await readChainRoot(this.blockchain, batchId);
    if ('error' in read) {
      this.logger.warn(`chainCheck for batch ${batchId} failed: ${read.error}`);
      return { error: read.error, checkedAt: new Date() };
    }
    return {
      chainRoot: read.root,
      dbRoot,
      match: read.root === dbRoot,
      checkedAt: new Date(),
    };
  }
}
