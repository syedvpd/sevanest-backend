import { Injectable } from '@nestjs/common';
import type { SendResult, SmsProvider } from './notification-providers.interface';

export interface CapturedSms {
  to: string;
  body: string;
}

/**
 * Deterministic SMS adapter for automated tests and local work: messages are kept in process memory and nothing is
 * sent. Configuration validation refuses SMS_PROVIDER=memory in production. It exposes no HTTP surface.
 */
@Injectable()
export class InMemorySmsProvider implements SmsProvider {
  private readonly messages: CapturedSms[] = [];

  sendSms(input: { to: string; body: string }): Promise<SendResult> {
    this.messages.push({ to: input.to, body: input.body });
    return Promise.resolve({ providerMessageId: `memory-${this.messages.length}` });
  }

  /** Test helper: the latest message sent to a number, or undefined. */
  lastTo(to: string): CapturedSms | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].to === to) {
        return this.messages[i];
      }
    }
    return undefined;
  }

  get sent(): readonly CapturedSms[] {
    return this.messages;
  }
}
