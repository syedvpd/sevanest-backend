import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import type {
  PushProvider,
  SendResult,
  WhatsAppProvider,
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
  body: string;
  idempotencyKey?: string;
}

/** Test and local adapter: keeps messages in process memory and can be told to fail. Refused in production by configuration. */
@Injectable()
export class InMemoryPushProvider implements PushProvider {
  readonly sent: CapturedMessage[] = [];
  failWith: ProviderError | null = null;

  sendPush(input: { deviceToken: string; title: string; body: string }): Promise<SendResult> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.sent.push({ to: input.deviceToken, title: input.title, body: input.body });
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
