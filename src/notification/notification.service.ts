import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    secure: false,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });

  async sendAlertEmail(severity: string, title: string, detail: string) {
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
        from: process.env.MAIL_USER,
        to: process.env.MAIL_TO,
        subject,
        html,
      });
      this.logger.log(`Alert email sent: ${subject}`);
    } catch (err) {
      this.logger.error(`Failed to send email: ${err.message}`);
    }
  }
}
