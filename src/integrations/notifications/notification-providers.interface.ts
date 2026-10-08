/**
 * Outbound messaging abstractions (FR-NOT-001..003). SMS and WhatsApp vendors are not yet selected (SRS §14 item 9);
 * push is Firebase Cloud Messaging. Foundation contracts: refine with the Notification module. Callers (queue handlers)
 * must treat sends as at-least-once and be idempotent.
 */
export const SMS_PROVIDER = Symbol('SMS_PROVIDER');
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface SendResult {
  providerMessageId: string;
}

export interface SmsProvider {
  /** Used for OTP and transactional SMS. `to` is an E.164 number. */
  sendSms(input: { to: string; body: string; idempotencyKey?: string }): Promise<SendResult>;
}

/** Optional channel in V1 (FR-NOT-003). */
export interface WhatsAppProvider {
  sendWhatsApp(input: { to: string; body: string; idempotencyKey?: string }): Promise<SendResult>;
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
