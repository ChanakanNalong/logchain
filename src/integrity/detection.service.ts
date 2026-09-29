import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** log ที่ส่งให้ detection คำนวณ feature ระดับ batch — เฉพาะ field ที่ใช้ (ไม่ส่ง message/hash) */
export interface BatchLogInput {
  eventType: string;
  severity: string;
  sourceIp: string | null;
  source: string;
  cdeScope: boolean;
  createdAt: string; // ISO-8601
}

/** ผลจำแนก batch จาก Isolation Forest — null เมื่อ "ยังไม่ได้จำแนก" (ดู scoreBatch) */
export interface BatchAnomalyResult {
  isAnomaly: boolean;
  score: number;
  reason: string;
}

/**
 * DetectionService — ตัวเดียวที่ backend เรียก detection ฝั่ง HTTP (Isolation Forest ระดับที่ 3)
 *
 * ออกแบบให้ **ไม่มีวัน throw**: ทุกความล้มเหลว (detection ล่ม / timeout / ยังไม่ train /
 * ตอบไม่เป็น JSON) คืน null — ตัวเรียก (sealBatch) จะไม่เก็บผล แล้วปิด batch ต่อได้ตามปกติ
 * เพราะระดับที่ 3 เป็นส่วนเสริม ไม่ใช่ gate ของ integrity
 *
 * ต่างจาก detection-consumer (Kafka) ตรงที่ตัวนี้เป็น request/response ตอนปิด batch
 * เพื่อจำแนก "ทั้งชุด" ไม่ใช่ทีละ log
 */
@Injectable()
export class DetectionService {
  private readonly logger = new Logger(DetectionService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (
      this.config.get<string>('DETECTION_URL', 'http://detection-api:8000') ||
      ''
    ).replace(/\/+$/, '');
    this.timeoutMs =
      Number(this.config.get<string>('DETECTION_TIMEOUT_MS', '4000')) || 4000;
  }

  /**
   * จำแนก batch หนึ่งชุดว่าผิดปกติไหม · คืน null เมื่อยังไม่ได้จำแนก:
   *   - ไม่ได้ตั้ง DETECTION_URL / ไม่มี log
   *   - detection ล่ม / timeout / ตอบ non-2xx / ตอบไม่เป็น JSON
   *   - โมเดลยังไม่ได้ train (model_available=false)
   */
  async scoreBatch(
    batchId: string,
    logs: BatchLogInput[],
  ): Promise<BatchAnomalyResult | null> {
    if (!this.baseUrl || logs.length === 0) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/detect-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_id: batchId, logs }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(
          `detect-batch คืน ${res.status} สำหรับ batch ${batchId} — ข้ามการจำแนก`,
        );
        return null;
      }
      const body = (await res.json()) as {
        is_anomaly?: boolean;
        score?: number;
        model_available?: boolean;
        reason?: string;
      };
      if (!body.model_available) return null; // ยังไม่ train → ไม่ถือว่าจำแนก
      return {
        isAnomaly: !!body.is_anomaly,
        score: Number(body.score) || 0,
        reason: String(body.reason ?? ''),
      };
    } catch (err) {
      // AbortError (timeout) หรือ network error — ไม่ทำให้ seal ล้ม
      this.logger.warn(
        `เรียก detect-batch ไม่สำเร็จสำหรับ batch ${batchId}: ${
          (err as Error).message
        } — ข้ามการจำแนก`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
