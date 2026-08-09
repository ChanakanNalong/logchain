import { IsIn, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { APP_ROLES } from '../admin.constants';
import type { AppRole } from '../admin.constants';

export class AssignRoleDto {
  /** guard ชั้นแรก — role นอก allowlist ถูกตีตกที่ ValidationPipe เป็น 400 */
  @ApiProperty({ enum: APP_ROLES })
  @IsString()
  @IsIn(APP_ROLES as readonly string[])
  role: AppRole;
}
