import {
    Injectable, NestInterceptor,
    ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { AuditService } from '../../audit/audit.service';

/**
 * AuditInterceptor — registered globally ใน AppModule
 *
 * ทำงานแบบ middleware ที่ wrap ทุก HTTP request:
 *   request เข้า → interceptor เริ่มจับเวลา → controller ทำงาน → interceptor บันทึก
 *
 * ข้ามเฉพาะ /health และ /metrics เพื่อลด noise
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
    constructor(private readonly auditService: AuditService) {}

    intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
        const req = ctx.switchToHttp().getRequest();
        const start = Date.now();

        return next.handle().pipe(
            tap({
                next: () => this.write(ctx, req, start),
                error: () => this.write(ctx, req, start),
            }),
        );
    }

    private write(ctx: ExecutionContext, req: any, start: number): void {
        // ข้าม health check และ metrics - ไม่มีประโยชน์ใน audit trail
        if (req.url?.startsWith('/health') || req.url?.startsWith('/metrics')) return;
    
        const res = ctx.switchToHttp().getResponse();
        const user = req.user;
    
        // fire-and-forget: audit ต้องไม่ block response (AuditService จัดการ error เองภายใน)
        void this.auditService.log({
            userId: user?.userId ?? 'anonymous',
            username: user?.username ?? null,
            action: `${req.method} ${req.route?.path ?? req.url}`,
            resource: req.url,
            method: req.method,
            statusCode: res.statusCode,
            // รองรับ proxy (nginx) ที่ forward IP มาใน header
            ipAddress: req.ip ?? req.headers['x-forwarded-for'],
            durationMs: Date.now() - start,
        })
    }
}
