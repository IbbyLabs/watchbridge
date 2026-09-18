import { Resend } from 'resend';
import { createLogger, type AppConfig } from '@watchbridge/core';
import {
  emailChangeEmail,
  passwordResetEmail,
  syncFailureEmail,
  syncRecoveryEmail,
  verificationEmail,
  type SyncAlert,
} from './templates.js';

const log = createLogger('mail');

export interface Mailer {
  sendVerificationEmail: (to: string, verifyUrl: string) => Promise<void>;
  sendPasswordResetEmail: (to: string, resetUrl: string) => Promise<void>;
  sendEmailChangeEmail: (to: string, confirmUrl: string) => Promise<void>;
  /** Alert the owner that a scheduled sync started failing. */
  sendSyncFailureEmail: (to: string, alert: SyncAlert) => Promise<void>;
  /** Tell the owner a previously-failing sync recovered. */
  sendSyncRecoveryEmail: (to: string, alert: Pick<SyncAlert, 'syncName' | 'syncsUrl'>) => Promise<void>;
  /** Verify the mail connection at startup; returns false if unavailable. */
  verify: () => Promise<boolean>;
}

interface Sender {
  live: boolean;
  /** Send one email; resolves to the provider message id (null in dev). */
  send: (to: string, subject: string, html: string, text: string) => Promise<string | null>;
  verify: () => Promise<boolean>;
}

function buildSender(config: AppConfig): Sender {
  if (!config.RESEND_API_KEY) {
    // No API key configured: log emails instead of sending, so dev works offline.
    log.warn('RESEND_API_KEY not set — emails will be logged, not sent');
    return {
      live: false,
      async send(to, subject) {
        log.info({ to, subject }, 'Email (dev, not delivered)');
        return null;
      },
      async verify() {
        return false;
      },
    };
  }

  const resend = new Resend(config.RESEND_API_KEY);
  return {
    live: true,
    async send(to, subject, html, text) {
      const { data, error } = await resend.emails.send({
        from: config.MAIL_FROM,
        to,
        subject,
        html,
        text,
      });
      if (error) throw new Error(`${error.name}: ${error.message}`);
      return data?.id ?? null;
    },
    async verify() {
      try {
        // Cheapest authenticated call: proves the API key is valid without sending.
        const { error } = await resend.domains.list();
        return !error;
      } catch (err) {
        log.error({ err }, 'Resend API key verification failed');
        return false;
      }
    },
  };
}

export function createMailer(config: AppConfig): Mailer {
  const sender = buildSender(config);
  const appName = config.APP_NAME;

  return {
    async sendVerificationEmail(to, verifyUrl) {
      const { subject, html, text } = verificationEmail(appName, verifyUrl);
      const messageId = await sender.send(to, subject, html, text);
      if (sender.live) log.info({ to, messageId }, 'Verification email sent');
      else log.info({ to, verifyUrl }, 'Verification email (dev, not delivered)');
    },
    async sendPasswordResetEmail(to, resetUrl) {
      const { subject, html, text } = passwordResetEmail(appName, resetUrl);
      const messageId = await sender.send(to, subject, html, text);
      if (sender.live) log.info({ to, messageId }, 'Password reset email sent');
      else log.info({ to, resetUrl }, 'Password reset email (dev, not delivered)');
    },
    async sendEmailChangeEmail(to, confirmUrl) {
      const { subject, html, text } = emailChangeEmail(appName, confirmUrl);
      const messageId = await sender.send(to, subject, html, text);
      if (sender.live) log.info({ to, messageId }, 'Email change confirmation sent');
      else log.info({ to, confirmUrl }, 'Email change confirmation (dev, not delivered)');
    },
    async sendSyncFailureEmail(to, alert) {
      const { subject, html, text } = syncFailureEmail(appName, alert);
      const messageId = await sender.send(to, subject, html, text);
      if (sender.live) log.info({ to, sync: alert.syncName, messageId }, 'Sync failure email sent');
      else log.info({ to, sync: alert.syncName }, 'Sync failure email (dev, not delivered)');
    },
    async sendSyncRecoveryEmail(to, alert) {
      const { subject, html, text } = syncRecoveryEmail(appName, alert);
      const messageId = await sender.send(to, subject, html, text);
      if (sender.live) log.info({ to, sync: alert.syncName, messageId }, 'Sync recovery email sent');
      else log.info({ to, sync: alert.syncName }, 'Sync recovery email (dev, not delivered)');
    },
    async verify() {
      return sender.verify();
    },
  };
}
