import { PiiMaskingService } from './pii-masking.service';

/**
 * credit_card masking: mask เฉพาะ PAN จริง (ผ่าน Luhn) · ข้าม UUID ทั้งก้อน
 * กัน false positive: batch id ใน URL (…-9420-211004614088) ถูก mask เป็น [PAN] แล้วไปโดน rule 90001
 */
describe('PiiMaskingService — credit_card', () => {
  const svc = new PiiMaskingService();
  const mask = (m: string) => svc.mask(m).masked;

  it('masks a real PAN (passes Luhn), grouped or solid', () => {
    expect(mask('card 4111 1111 1111 1111 ok')).toBe('card [PAN] ok');
    expect(mask('card 4111-1111-1111-1111 ok')).toBe('card [PAN] ok');
    expect(mask('card 4111111111111111 ok')).toBe('card [PAN] ok');
    expect(mask('mc 5555 5555 5555 4444')).toBe('mc [PAN]');
    expect(svc.mask('card 4111111111111111').hadPii).toBe(true);
  });

  it('leaves a 16-digit number that fails Luhn untouched', () => {
    expect(mask('ref 5555 4444 3333 2222 done')).toBe(
      'ref 5555 4444 3333 2222 done',
    );
    expect(mask('ref 1234 5678 9012 3456 done')).toBe(
      'ref 1234 5678 9012 3456 done',
    );
    expect(svc.mask('ref 1234567890123456').hadPii).toBe(false);
  });

  it('does not mask a UUID whose tail is all digits (the 90001 false positive)', () => {
    const uuid = '1d433a5d-52b1-4c3e-9420-211004614088';
    const path = `GET /api/v1/batches/${uuid}/diff 200`;
    expect(mask(path)).toBe(path);
    expect(mask(path)).not.toContain('[PAN]');
    // UUID ตัวพิมพ์ใหญ่ก็ข้าม
    expect(mask(uuid.toUpperCase())).toBe(uuid.toUpperCase());
  });

  it('still masks a real PAN that sits next to a UUID', () => {
    const uuid = '1d433a5d-52b1-4c3e-9420-211004614088';
    const out = mask(`${uuid} paid 4111 1111 1111 1111`);
    expect(out).toBe(`${uuid} paid [PAN]`);
  });

  it('keeps the other maskers working', () => {
    expect(mask('mail a@b.co')).toBe('mail [EMAIL]');
    expect(mask('ip 192.168.1.100 seen')).toBe('ip 192.168.1.xxx seen');
  });
});
