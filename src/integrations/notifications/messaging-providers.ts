import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import {
  InvalidDeviceTokenError,
  type PushProvider,
  type SendResult,
  type WhatsAppProvider,
} from './notification-providers.interface';

/** Used while no push (FCM) credentials are configured: every send fails, permanently. */
@Injectable()
export class DisabledPushProvider implements PushProvider {
  sendPush(): Promise<SendResult> {
    return Promise.reject(new ProviderError('push', 'Push delivery is not configured', false));
  }
}

/** Used while no WhatsApp vendor is selected (optional channel, FR-NOT-003 / Q-08). */
@Injectable()
export class DisabledWhatsAppProvider implements WhatsAppProvider {
  sendWhatsApp(): Promise<SendResult> {
    return Promise.reject(
      new ProviderError('whatsapp', 'WhatsApp delivery is not configured', false),
    );
  }
}

export interface CapturedMessage {
  to: string;
  title?: string;
  /** Push only: the FCM data map exactly as it would be sent. */
  data?: Record<string, string>;
  body: string;
  idempotencyKey?: string;
}

/** Test and local adapter: keeps messages in process memory and can be told to fail. Refused in production by configuration. */
@Injectable()
export class InMemoryPushProvider implements PushProvider {
  readonly sent: CapturedMessage[] = [];
  failWith: ProviderError | null = null;
  /** Tokens the "provider" reports as unregistered (test seam for the invalid-token clean-up). */
  readonly invalidTokens = new Set<string>();

  sendPush(input: {
    deviceToken: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<SendResult> {
    if (this.invalidTokens.has(input.deviceToken)) {
      return Promise.reject(new InvalidDeviceTokenError('push'));
    }
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({
      to: input.deviceToken,
      title: input.title,
      body: input.body,
      data: input.data,
    });
    return Promise.resolve({ providerMessageId: `push-${this.sent.length}` });
  }
}

@Injectable()
export class InMemoryWhatsAppProvider implements WhatsAppProvider {
  readonly sent: CapturedMessage[] = [];
  failWith: ProviderError | null = null;

  sendWhatsApp(input: { to: string; body: string; idempotencyKey?: string }): Promise<SendResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({ to: input.to, body: input.body, idempotencyKey: input.idempotencyKey });
    return Promise.resolve({ providerMessageId: `wa-${this.sent.length}` });
  }
}
