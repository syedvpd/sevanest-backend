import { ProviderError } from '../provider-error';

/**
 * Outbound messaging abstractions (FR-NOT-001..003). SMS and WhatsApp vendors are not yet selected (SRS §14 item 9);
 * push is Firebase Cloud Messaging. Foundation contracts: refine with the Notification module. Callers (queue handlers)
 * must treat sends as at-least-once and be idempotent.
 */
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface SendResult {
  providerMessageId: string;
}

/**
 * A pre-registered message template (India: DLT). Free-text providers (Twilio) ignore it and send `body`; template providers
 * (MSG91) ignore `body` and send the registered template with these variables.
 */
export interface SmsTemplate {
  key: 'OTP';
  variables: Record<string, string>;
}

export interface SmsProvider {
  /** Used for OTP and transactional SMS. `to` is an E.164 number. */
  sendSms(input: {
    to: string;
    body: string;
    template?: SmsTemplate;
    idempotencyKey?: string;
  }): Promise<SendResult>;
}

/** Optional channel in V1 (FR-NOT-003). */
export interface WhatsAppProvider {
  sendWhatsApp(input: { to: string; body: string; idempotencyKey?: string }): Promise<SendResult>;
}

/** E-mail channel (TRD section 9, DEC-17). Plain-text transactional messages; wording comes from the admin-edited EMAIL template. */
export interface EmailProvider {
  sendEmail(input: {
    to: string;
    subject: string;
    body: string;
    idempotencyKey?: string;
  }): Promise<SendResult>;
}

export interface PushProvider {
  sendPush(input: {
    deviceToken: string;
    title: string;
    body: string;
    /** Deep-link routing data only; never personal data. */
    data?: Record<string, string>;
  }): Promise<SendResult>;
}

/**
 * The push provider says this device token will never work again (app uninstalled, token rotated, malformed). Permanent for that
 * token: the caller removes the binding and does not retry it. Never carries the token.
 */
export class InvalidDeviceTokenError extends ProviderError {
  constructor(provider: string, cause?: unknown) {
    super(
      provider,
      `${provider} rejected the device token as invalid or unregistered`,
      false,
      cause,
    );
    this.name = 'InvalidDeviceTokenError';
  }
}
