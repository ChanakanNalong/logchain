import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuditService } from '../../audit/audit.service';

type AuditedRequest = Request & {
  user?: { userId?: string; username?: string };
  // controller ตั้งได้เมื่อ URL มีข้อมูลส่วนบุคคล (ดู ErasureController)
  auditResource?: string;
};

/**
 * AuditMiddleware — ลงทะเบียนกับทุก route ใน AppModule.configure()
 *
 * บันทึกตอน response ส่งจบ (event `finish`) ไม่ใช่ใน interceptor เพราะ
 *   - interceptor อ่าน res.statusCode ก่อน exception filter ตั้งค่าจริง → 400/404/500 ถูกบันทึกเป็น 200/201
 *   - guard ทำงานก่อน interceptor → คำขอที่ถูกปฏิเสธ (401/403/429) ไม่ถูกบันทึกเลย
 * ทั้งสองข้อทำให้ audit trail ไม่มีความพยายามเข้าถึงที่ล้มเหลว (PCI DSS 10.2.1.4) — แก้ 2026-10-04
 *
 * ข้ามเฉพาะ /health เพื่อลด noise (/metrics อยู่ port แยก :9464 — ใครยิง :3000/metrics = 404 และถูกบันทึก)
 */
@Injectable()
export class AuditMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AuditMiddleware.name);

  constructor(private readonly auditService: AuditService) {}

  use(req: AuditedRequest, res: Response, next: NextFunction): void {
    if (req.originalUrl.startsWith('/health')) return next();

    const start = Date.now();
    let written = false;
    const write = () => {
      // finish = ส่งครบ · close = ส่งครบหรือ client ตัดกลางทาง — บันทึกครั้งเดียว
      if (written) return;
      written = true;
      try {
        this.write(req, res, start);
      } catch (err) {
        // audit ล้มต้องไม่กระทบคำขอหลัก (response ส่งไปแล้วด้วย)
        this.logger.error('Audit capture failed', err);
      }
    };
    res.once('finish', write);
    res.once('close', write);
    next();
  }

  private write(req: AuditedRequest, res: Response, start: number): void {
    const user = req.user;
    const route = (req.route as { path?: string } | undefined)?.path;
    // originalUrl ไม่ถูกตัดตาม mount path ของ middleware (req.url / req.path ถูกตัดได้)
    const path = req.originalUrl.split('?')[0];

    // fire-and-forget: AuditService จับ error เองภายใน ไม่ throw
    void this.auditService.log({
      // ไม่มี token / token ใช้ไม่ได้ = guard ปฏิเสธก่อนตั้ง req.user
      userId: user?.userId ?? 'anonymous',
      username: user?.username ?? null,
      action: `${req.method} ${route ?? path}`,
      resource: req.auditResource ?? this.resourceOf(req, path, route),
      method: req.method,
      statusCode: res.statusCode,
      // trust proxy ตั้งใน main.ts → req.ip เป็น IP ของ client จริงหลัง proxy
      ipAddress: req.ip ?? null,
      durationMs: Date.now() - start,
    });
  }

  /**
   * คำขอลบข้อมูลที่ไม่สำเร็จ (401/403/404/500) ไม่ถึงจุดที่ ErasureController แทน id ด้วย pseudonym
   * → เก็บ pattern ของ route แทน URL จริง ไม่งั้น id ตัวจริงของผู้ใช้ค้างใน audit_access
   */
  private resourceOf(
    req: AuditedRequest,
    path: string,
    route?: string,
  ): string {
    if (path.includes('/erasure/')) return route ?? '/erasure/[redacted]';
    return req.originalUrl;
  }
}
