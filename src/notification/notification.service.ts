import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { VaultService } from '../vault/vault.service';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private transporter: nodemailer.Transporter | null = null;
  private mailFrom: string | null = null;
  private mailTo: string | null = null;

  constructor(private readonly vault: VaultService) {}

  async onModuleInit() {
    await this.vault.init();
    const smtp = this.vault.get().notification;

    if (!smtp || !smtp.host || !smtp.user) {
      this.logger.warn(
        'Notification disabled — SMTP not configured in Vault (host/user empty)',
      );
      return;
    }

    this.transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port),
      secure: false,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });
    this.mailFrom = smtp.user;
    this.mailTo = smtp.to || smtp.user;

    this.logger.log(
      `NotificationService ready (SMTP ${smtp.host}:${smtp.port})`,
    );
  }

  /**
   * @param repeat มีเมื่อเป็นการเตือนซ้ำของ alert ที่ยัง OPEN อยู่ (AlertsService.recordRepeat)
   */
  async sendAlertEmail(
    severity: string,
    title: string,
    detail: string,
    repeat?: { occurrences: number; firstSeen: Date; lastSeen: Date },
  ) {
    const repeatTag = repeat ? ` (repeat ×${repeat.occurrences})` : '';
    if (!this.transporter) {
      this.logger.warn(
        `Skipping alert email (SMTP not initialized): [${severity}]${repeatTag} ${title}`,
      );
      return;
    }

    const subject = `[${severity}] Alert${repeatTag}: ${title}`;
    // escape ทุกค่า — title/detail มาจาก log ที่ผู้โจมตีส่งเข้ามาเอง (detail.log_message)
    // ถ้าไม่ escape ใส่ HTML/ลิงก์ปลอมลงใน email ที่ส่งถึงทีม security ได้
    const repeatHtml = repeat
      ? `<p>Still happening while this alert is OPEN — fired
           <b>${repeat.occurrences}</b> times · first seen
           ${escapeHtml(repeat.firstSeen.toISOString())} · last seen
           ${escapeHtml(repeat.lastSeen.toISOString())}</p>`
      : '';
    const html = `
      <h2 style="color:${severity === 'CRITICAL' ? 'red' : 'orange'}">
        [${escapeHtml(severity)}] ${escapeHtml(title)}
      </h2>
      ${repeatHtml}
      <pre style="white-space:pre-wrap">${escapeHtml(detail)}</pre>
      <p><small>Logchain Alert System</small></p>
    `;

    try {
      await this.transporter.sendMail({
        from: this.mailFrom!,
        to: this.mailTo!,
        subject,
        html,
      });
      this.logger.log(`Alert email sent: ${subject}`);
    } catch (err: any) {
      this.logger.error(`Failed to send email: ${err.message}`);
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
