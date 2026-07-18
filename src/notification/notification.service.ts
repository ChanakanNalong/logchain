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
      this.logger.warn('Notification disabled — SMTP not configured in Vault (host/user empty)');
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

    this.logger.log(`NotificationService ready (SMTP ${smtp.host}:${smtp.port})`);
  }

  async sendAlertEmail(severity: string, title: string, detail: string) {
    if (!this.transporter) {
      this.logger.warn(`Skipping alert email (SMTP not initialized): ${title}`);
      return;
    }

    const subject = `[${severity}] Alert: ${title}`;
    const html = `
      <h2 style="color:${severity === 'CRITICAL' ? 'red' : 'orange'}">
        [${severity}] ${title}
      </h2>
      <p>${detail}</p>
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
