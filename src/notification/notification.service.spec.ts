import { Logger } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { VaultService } from '../vault/vault.service';

describe('NotificationService.sendAlertEmail', () => {
  let svc: NotificationService;
  /** argument ที่ nodemailer.sendMail ได้รับ — อ่าน subject/html ในเทสต์ */
  let sendMail: jest.Mock<Promise<void>, [{ subject: string; html: string }]>;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    svc = new NotificationService({} as VaultService);
    sendMail = jest.fn<Promise<void>, [{ subject: string; html: string }]>();
    // เทียบเท่า onModuleInit ที่ตั้ง SMTP สำเร็จ
    Object.assign(svc as unknown as Record<string, unknown>, {
      transporter: { sendMail },
      mailFrom: 'from@x',
      mailTo: 'to@x',
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('escapes attacker-controlled text — log messages end up in the email body', async () => {
    await svc.sendAlertEmail(
      'CRITICAL',
      '<img src=x onerror=alert(1)>',
      JSON.stringify({
        log_message: '<a href="https://evil.example">reset your password</a>',
      }),
    );

    const { html } = sendMail.mock.calls[0][0];
    expect(html).not.toContain('<a href');
    expect(html).not.toContain('<img');
    expect(html).toContain(
      '&lt;a href=\\&quot;https://evil.example\\&quot;&gt;',
    );
  });

  it('marks repeat notifications in the subject and body', async () => {
    await svc.sendAlertEmail('CRITICAL', 'Brute force', '{}', {
      occurrences: 7,
      firstSeen: new Date('2026-09-22T10:01:00.000Z'),
      lastSeen: new Date('2026-09-23T01:00:00.000Z'),
    });

    const { subject, html } = sendMail.mock.calls[0][0];
    expect(subject).toBe('[CRITICAL] Alert (repeat ×7): Brute force');
    expect(html).toContain('<b>7</b> times');
    expect(html).toContain('2026-09-22T10:01:00.000Z');
  });
});
