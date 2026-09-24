import {
  Controller,
  Delete,
  ForbiddenException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard, Roles } from '../auth/guards/roles.guard';
import { ErasureService } from './erasure.service';

// PDPA right-to-erasure — admin-only (sensitive operation)
@Controller('erasure')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class ErasureController {
  constructor(private readonly erasureService: ErasureService) {}

  /**
   * `requestedBy` ใน tombstone มาจาก JWT (JwtStrategy.validate) ไม่ใช่ body
   * เดิมรับจาก body — ผู้ส่งคำขอพิมพ์ชื่อใครก็ได้ลงหลักฐานการลบ (และไม่ส่ง = "unknown")
   */
  @Delete('user/:userId')
  async erase(
    @Param('userId') userId: string,
    @Req()
    req: {
      user?: { userId?: string; username?: string };
      url: string;
      auditResource?: string;
    },
  ) {
    const requestedBy = req.user?.username ?? req.user?.userId;
    // ถึงตรงนี้ AuthGuard ผ่านแล้ว req.user ต้องมีเสมอ — เช็คไว้กันกรณี guard ถูกถอด
    if (!requestedBy) {
      throw new ForbiddenException('Missing authenticated identity');
    }
    const result = (await this.erasureService.eraseUser(
      userId,
      requestedBy,
    )) as { tombstone: { pseudonym: string } };
    // AuditInterceptor บันทึกคำขอนี้หลังเรา — ไม่งั้น URL ของคำขอลบเองจะเก็บ userId ตัวจริงไว้ใน audit_access
    req.auditResource = req.url
      .split('/')
      .map((seg) =>
        seg === encodeURIComponent(userId) ? result.tombstone.pseudonym : seg,
      )
      .join('/');
    return result;
  }
}
