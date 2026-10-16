import { Injectable } from '@nestjs/common';
import { providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import type { EmailProvider, SendResult } from './notification-providers.interface';

/** Used while no e-mail vendor is configured (DEC-17). Every send fails permanently; the channel is simply off. */
@Injectable()
export class DisabledEmailProvider implements EmailProvider {
  sendEmail(): Promise<SendResult> {
    return Promise.reject(new ProviderError('email', 'E-mail delivery is not configured', false));
  }
}

export interface CapturedEmail {
  to: string;
  subject: string;
  body: string;
  idempotencyKey?: string;
}

/** Test and local adapter: keeps messages in process memory. Refused in production and staging by configuration. */
@Injectable()
export class InMemoryEmailProvider implements EmailProvider {
  readonly sent: CapturedEmail[] = [];
  failWith: ProviderError | null = null;

  sendEmail(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey?: string;
  }): Promise<SendResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({ ...input });
    return Promise.resolve({ providerMessageId: `memory-email-${this.sent.length}` });
  }
}

export interface BrevoSettings {
  apiKey: string;
  fromAddress: string;
  fromName: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * Brevo transactional e-mail over HTTPS (POST /v3/smtp/email, `api-key` header). Plain-text body only: wording comes from the admin-edited
 * template. Timeouts, network errors, 429 and 5xx are retryable (the notification queue retries them), anything else is a permanent
 * refusal. The request (recipient, text) never appears in an error message.
 */
@Injectable()
export class BrevoEmailProvider implements EmailProvider {
  constructor(private readonly settings: BrevoSettings) {}

  async sendEmail(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey?: string;
  }): Promise<SendResult> {
    const base = this.settings.baseUrl ?? 'https://api.brevo.com';
    const { json } = await providerRequest(
      'brevo',
      `${base}/v3/smtp/email`,
      {
        method: 'POST',
        headers: {
          'api-key': this.settings.apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: this.settings.fromName, email: this.settings.fromAddress },
          to: [{ email: input.to }],
          subject: input.subject,
          textContent: input.body,
        }),
      },
      this.settings.timeoutMs,
    );
    const messageId = (json as { messageId?: unknown } | null)?.messageId;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new ProviderError('brevo', 'brevo did not return a message id', false);
    }
    return { providerMessageId: messageId };
  }
}
