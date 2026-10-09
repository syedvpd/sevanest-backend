import { Injectable } from '@nestjs/common';
import { ProviderError } from '../provider-error';
import type { SendResult, SmsProvider } from './notification-providers.interface';

/** Used while no SMS vendor is configured (SRS §14 item 9). Every send fails with a non-retryable ProviderError. */
@Injectable()
export class DisabledSmsProvider implements SmsProvider {
  sendSms(): Promise<SendResult> {
    return Promise.reject(new ProviderError('sms', 'SMS delivery is not configured', false));
  }
}
