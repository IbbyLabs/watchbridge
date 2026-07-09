import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger, type AppConfig } from '@watchbridge/core';
import { passwordResetEmail, verificationEmail } from './templates.js';

const log = createLogger('mail');

export interface Mailer {
  sendVerificationEmail: (to: string, verifyUrl: string) => Promise<void>;
  sendPasswordResetEmail: (to: string, resetUrl: string) => Promise<void>;
  /** Verify the SMTP connection at startup; returns false if unavailable. */
  verify: () => Promise<boolean>;
}

function buildTransport(config: AppConfig): { transport: Transporter; live: boolean } {
  if (!config.SMTP_HOST) {
    // No SMTP configured: log emails instead of sending, so dev works offline.
    log.warn('SMTP_HOST not set — emails will be logged, not sent');
    return { transport: nodemailer.createTransport({ jsonTransport: true }), live: false };
  }
  return {
    transport: nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE, // true=implicit TLS (465), false=STARTTLS (587)
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    }),
    live: true,
  };
}

export function createMailer(config: AppConfig): Mailer {
  const { transport, live } = buildTransport(config);
  const from = config.MAIL_FROM;
  const appName = config.APP_NAME;

  return {
    async sendVerificationEmail(to, verifyUrl) {
      const { subject, html, text } = verificationEmail(appName, verifyUrl);
      const info = await transport.sendMail({ from, to, subject, text, html });
      if (live) log.info({ to, messageId: info.messageId }, 'Verification email sent');
      else log.info({ to, verifyUrl }, 'Verification email (dev, not delivered)');
    },
    async sendPasswordResetEmail(to, resetUrl) {
      const { subject, html, text } = passwordResetEmail(appName, resetUrl);
      const info = await transport.sendMail({ from, to, subject, text, html });
      if (live) log.info({ to, messageId: info.messageId }, 'Password reset email sent');
      else log.info({ to, resetUrl }, 'Password reset email (dev, not delivered)');
    },
    async verify() {
      if (!live) return false;
      try {
        await transport.verify();
        return true;
      } catch (err) {
        log.error({ err }, 'SMTP verification failed');
        return false;
      }
    },
  };
}
