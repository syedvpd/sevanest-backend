import { Injectable } from '@nestjs/common';
import { basicAuth, providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import type { SendResult, SmsProvider, WhatsAppProvider } from './notification-providers.interface';

export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  /** Exactly one of messagingServiceSid / smsFrom identifies the SMS sender. A messaging service is preferred for India. */
  messagingServiceSid?: string;
  smsFrom?: string;
  whatsappFrom?: string;
  timeoutMs: number;
  /** Test seam; production uses the real API host. */
  baseUrl?: string;
}

/** Twilio Programmable Messaging: POST /2010-04-01/Accounts/{sid}/Messages.json (form-encoded, HTTP Basic auth). */
class TwilioMessages {
  constructor(protected readonly settings: TwilioSettings) {}

  protected async send(
    to: string,
    body: string,
    from: { key: string; value: string },
  ): Promise<SendResult> {
    const form = new URLSearchParams({ To: to, Body: body, [from.key]: from.value });
    const base = this.settings.baseUrl ?? 'https://api.twilio.com';
    const { json } = await providerRequest(
      'twilio',
      `${base}/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuth(this.settings.accountSid, this.settings.authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      },
      this.settings.timeoutMs,
    );
    const reply = json as { sid?: unknown; status?: unknown } | null;
    // A 2xx without a message SID, or a message already failed/undelivered, is not a delivery we may report.
    if (
      typeof reply?.sid !== 'string' ||
      reply.status === 'failed' ||
      reply.status === 'undelivered'
    ) {
      throw new ProviderError('twilio', 'twilio did not accept the message', false);
    }
    return { providerMessageId: reply.sid };
  }
}

@Injectable()
export class TwilioSmsProvider extends TwilioMessages implements SmsProvider {
  sendSms(input: { to: string; body: string }): Promise<SendResult> {
    const from = this.settings.messagingServiceSid
      ? { key: 'MessagingServiceSid', value: this.settings.messagingServiceSid }
      : { key: 'From', value: this.settings.smsFrom ?? '' };
    return this.send(input.to, input.body, from);
  }
}

@Injectable()
export class TwilioWhatsAppProvider extends TwilioMessages implements WhatsAppProvider {
  sendWhatsApp(input: { to: string; body: string }): Promise<SendResult> {
    const to = input.to.startsWith('whatsapp:') ? input.to : `whatsapp:${input.to}`;
    const sender = this.settings.whatsappFrom ?? '';
    const value = sender.startsWith('whatsapp:') ? sender : `whatsapp:${sender}`;
    return this.send(to, input.body, { key: 'From', value });
  }
}
