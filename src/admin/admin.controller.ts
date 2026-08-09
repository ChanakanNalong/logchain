import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles, RolesGuard } from '../auth/guards/roles.guard';
import { AuditService } from '../audit/audit.service';
import { ADMIN_ROLE, APP_ROLES, isAppRole } from './admin.constants';
import { AssignRoleDto } from './dto/assign-role.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { KeycloakAdminService, KeycloakUser } from './keycloak-admin.service';

/** identity ที่ JwtStrategy.validate แปะไว้บน req.user (userId = JWT sub) */
interface Caller {
  userId: string;
  username?: string;
  roles: string[];
}

export interface AdminUserView {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  roles: string[];
}

/**
 * AdminController — จัดการ user/role ของ realm (admin เท่านั้น ไม่มีข้อยกเว้น)
 *
 * source of truth คือ Keycloak ไม่ใช่ app DB — ที่นี่ทำหน้าที่ proxy ที่มี
 * guard กัน privilege escalation 3 ชั้น:
 *   1. role allowlist    — รับเฉพาะ 5 app role (400) กันยัด realm-management role
 *   2. last-admin guard  — ห้ามทำให้ realm เหลือ admin ที่ใช้งานได้ 0 คน (409)
 *   3. self guard        — ห้าม admin ถอด/ปิดบัญชีตัวเอง = ล็อกตัวเองออก (403)
 *
 * actor ของทุก mutation อ่านจาก JWT sub เท่านั้น ไม่เชื่อ body ที่ frontend ส่งมา
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(
    private readonly keycloak: KeycloakAdminService,
    private readonly audit: AuditService,
  ) {}

  /** GET /api/v1/admin/users — user ทั้งหมด + realm role (เฉพาะ 5 app role) */
  @Get('users')
  @ApiOperation({ summary: 'List realm users with their app roles' })
  async listUsers(): Promise<AdminUserView[]> {
    // ดึงสมาชิกทีละ role แทนที่จะยิง role-mapping ต่อ user (N+1)
    // ผลพลอยได้: roles ถูก filter เหลือแค่ allowlist โดยธรรมชาติ —
    // default-roles-logchain / offline_access / uma_authorization ไม่หลุดออกไป
    const [users, ...membership] = await Promise.all([
      this.keycloak.listUsers(),
      ...APP_ROLES.map((role) => this.keycloak.getRoleUsers(role)),
    ]);

    const rolesByUser = new Map<string, string[]>();
    membership.forEach((members, i) => {
      for (const member of members) {
        const list = rolesByUser.get(member.id) ?? [];
        list.push(APP_ROLES[i]);
        rolesByUser.set(member.id, list);
      }
    });

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: u.enabled,
      roles: rolesByUser.get(u.id) ?? [],
    }));
  }

  /** GET /api/v1/admin/roles — allowlist ตายตัว ไม่ใช่ raw list จาก Keycloak */
  @Get('roles')
  @ApiOperation({ summary: 'Assignable app roles (fixed allowlist)' })
  listRoles(): string[] {
    return [...APP_ROLES];
  }

  /** POST /api/v1/admin/users/:id/roles — assign role (allowlist guard) */
  @Post('users/:id/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign an app role to a user' })
  async assignRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRoleDto,
    @Req() req: any,
  ) {
    const caller = this.caller(req);

    // DTO @IsIn(APP_ROLES) ตีตก role นอก allowlist เป็น 400 ตั้งแต่ ValidationPipe แล้ว
    await this.keycloak.assignRealmRole(id, dto.role);

    await this.writeAudit(
      caller,
      req,
      'ROLE_ASSIGN',
      `user:${id} role:${dto.role}`,
      HttpStatus.OK,
    );
    return { id, role: dto.role, assigned: true };
  }

  /** DELETE /api/v1/admin/users/:id/roles/:role — remove role (allowlist + last-admin + self) */
  @Delete('users/:id/roles/:role')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an app role from a user' })
  async removeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
    @Req() req: any,
  ) {
    const caller = this.caller(req);

    // :role มาทาง path — ValidationPipe ไม่ช่วย ต้องเช็ค allowlist เอง
    if (!isAppRole(role)) {
      throw new BadRequestException(`Role not assignable: ${role}`);
    }

    if (role === ADMIN_ROLE) {
      // self guard มาก่อน last-admin: ถ้า caller คือ admin คนสุดท้ายจะได้ error
      // ที่ตรงเหตุ ("ถอดสิทธิ์ตัวเองไม่ได้") ไม่ใช่ 409 ที่ชวนงง
      if (id === caller.userId) {
        throw new ForbiddenException('Cannot remove your own admin role');
      }
      await this.assertNotLastAdmin(id);
    }

    await this.keycloak.removeRealmRole(id, role);

    await this.writeAudit(
      caller,
      req,
      'ROLE_REVOKE',
      `user:${id} role:${role}`,
      HttpStatus.OK,
    );
    return { id, role, removed: true };
  }

  /** PATCH /api/v1/admin/users/:id — enable/disable (self + last-admin) */
  @Patch('users/:id')
  @ApiOperation({ summary: 'Enable or disable a user' })
  async updateUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: any,
  ) {
    const caller = this.caller(req);

    if (id === caller.userId) {
      throw new ForbiddenException('Cannot change your own account status');
    }

    if (!dto.enabled) {
      await this.assertNotLastAdmin(id);
    }

    await this.keycloak.setUserEnabled(id, dto.enabled);

    const action = dto.enabled ? 'USER_ENABLE' : 'USER_DISABLE';
    await this.writeAudit(caller, req, action, `user:${id}`, HttpStatus.OK);
    return { id, enabled: dto.enabled };
  }

  // ── guards ───────────────────────────────────────────────────────────────

  /**
   * 409 ถ้า target เป็น admin ที่ enabled อยู่คนสุดท้าย
   *
   * นับเฉพาะ admin ที่ enabled เพราะ admin ที่ถูก disable ล็อกอินไม่ได้ =
   * จัดการระบบไม่ได้จริง ถ้านับรวมด้วยจะเผลอปล่อยให้ realm เหลือ admin ที่
   * ใช้งานไม่ได้ล้วน ๆ
   */
  private async assertNotLastAdmin(targetUserId: string): Promise<void> {
    const enabledAdmins = (await this.keycloak.getRoleUsers(ADMIN_ROLE)).filter(
      (u) => u.enabled,
    );

    const targetIsActiveAdmin = enabledAdmins.some(
      (u: KeycloakUser) => u.id === targetUserId,
    );
    if (targetIsActiveAdmin && enabledAdmins.length <= 1) {
      throw new ConflictException('System must keep at least one active admin');
    }
  }

  // ── audit ────────────────────────────────────────────────────────────────

  private caller(req: any): Caller {
    const user = req.user as Caller | undefined;
    // ถึงตรงนี้ AuthGuard ผ่านแล้ว req.user ต้องมีเสมอ — เช็คไว้กันกรณี guard ถูกถอด
    if (!user?.userId)
      throw new ForbiddenException('Missing authenticated identity');
    return user;
  }

  /**
   * audit เฉพาะการเปลี่ยน privilege — ละเอียดกว่า AuditInterceptor ตัว global
   * ที่บันทึกแค่ "มีคนเรียก endpoint นี้" ตรงนี้ต้องตอบได้ว่า "ใครแก้ role ของใคร"
   */
  private async writeAudit(
    caller: Caller,
    req: any,
    action: string,
    resource: string,
    statusCode: number,
  ) {
    await this.audit.log({
      userId: caller.userId, // JWT sub — ไม่ใช่ค่าจาก body
      username: caller.username ?? null,
      action,
      resource,
      method: req.method,
      statusCode,
      ipAddress: req.ip ?? req.headers?.['x-forwarded-for'] ?? null,
    });
  }
}
