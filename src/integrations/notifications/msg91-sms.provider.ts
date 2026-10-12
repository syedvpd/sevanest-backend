import { Injectable } from '@nestjs/common';
import { providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import type { SendResult, SmsProvider, SmsTemplate } from './notification-providers.interface';

export interface Msg91Settings {
  authKey: string;
  /** DLT-registered flow template (created in the MSG91 panel) used for the login OTP. */
  otpTemplateId: string;
  /** Name of the OTP variable inside that template, e.g. "OTP" for ##OTP##. */
  otpVariable: string;
  timeoutMs: number;
  baseUrl?: string;
}

/**
 * MSG91 Flow API (India, DLT): POST /api/v5/flow with the `authkey` header. Indian regulation only lets DLT-registered templates
 * be sent, so this adapter sends TEMPLATE messages only; free text (no registered template) is refused permanently instead of
 * being sent in a form the operator would block. Only the OTP template is mapped today; other SMS templates are an open item.
 */
@Injectable()
export class Msg91SmsProvider implements SmsProvider {
  constructor(private readonly settings: Msg91Settings) {}

  async sendSms(input: { to: string; body: string; template?: SmsTemplate }): Promise<SendResult> {
    if (input.template?.key !== 'OTP') {
      throw new ProviderError('msg91', 'no DLT template is mapped for this SMS', false);
    }
    const mobile = input.to.replace(/^\+/, '');
    const code = input.template.variables.code;
    if (!code) throw new ProviderError('msg91', 'the OTP template needs the code', false);
    const base = this.settings.baseUrl ?? 'https://control.msg91.com';
    const { json } = await providerRequest(
      'msg91',
      `${base}/api/v5/flow`,
      {
        method: 'POST',
        headers: {
          authkey: this.settings.authKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          template_id: this.settings.otpTemplateId,
          short_url: '0',
          recipients: [{ mobiles: mobile, [this.settings.otpVariable]: code }],
        }),
      },
      this.settings.timeoutMs,
    );
    const reply = json as { type?: unknown; message?: unknown } | null;
    // MSG91 answers HTTP 200 with {"type":"error"} for rejected requests: that is not a delivery.
    if (reply?.type !== 'success' || typeof reply.message !== 'string') {
      throw new ProviderError('msg91', 'msg91 did not accept the message', false);
    }
    return { providerMessageId: reply.message };
  }
}
