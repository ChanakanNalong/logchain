import 'reflect-metadata';
import { ROLES_KEY } from '../auth/guards/roles.guard';
import { AlertsController } from './alerts.controller';

/**
 * RolesGuard ปล่อยผ่านทันทีถ้า handler ไม่มี metadata ROLES_KEY
 * (`if (!required?.length) return true`) — endpoint ที่ลืมใส่ @Roles จึงเปิดให้
 * token ไหนก็ได้ที่ auth ผ่าน รวมถึง service account ที่ไม่มี role เลย
 * ครั้งหนึ่ง controller นี้ไม่มี @Roles สักตัว เทสชุดนี้กันไม่ให้หลุดซ้ำแบบเงียบๆ
 */
describe('AlertsController role metadata', () => {
  const rolesOf = (name: keyof AlertsController) =>
    Reflect.getMetadata(ROLES_KEY, AlertsController.prototype[name]) as
      | string[]
      | undefined;

  it.each(['create', 'findAll', 'resolve'] as const)(
    '%s ประกาศ role ที่ต้องมีไว้',
    (handler) => {
      expect(rolesOf(handler)?.length ?? 0).toBeGreaterThan(0);
    },
  );

  it('การเขียน/ปิด alert ไม่เปิดให้ analyst (อ่านได้อย่างเดียว)', () => {
    expect(rolesOf('create')).not.toContain('analyst');
    expect(rolesOf('resolve')).not.toContain('analyst');
    expect(rolesOf('findAll')).toContain('analyst');
  });
});
