/**
 * Notification events (FRD section 6, PROPOSED matrix) and the placeholders a template may use for each. Producers only
 * name the event, the recipients and these non-personal parameters; wording and channels are admin-configured templates.
 */
export const NOTIFICATION_TOPIC = 'notification';

export const NotificationEvent = {
  JOB_OPPORTUNITY: 'JOB_OPPORTUNITY',
  INTERVIEW_TRIAL_SCHEDULED: 'INTERVIEW_TRIAL_SCHEDULED',
  BOOKING_CONFIRMED: 'BOOKING_CONFIRMED',
  PAYMENT_SUCCEEDED: 'PAYMENT_SUCCEEDED',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  VERIFICATION_APPROVED: 'VERIFICATION_APPROVED',
  VERIFICATION_REJECTED: 'VERIFICATION_REJECTED',
  REPLACEMENT_UPDATE: 'REPLACEMENT_UPDATE',
  TICKET_UPDATE: 'TICKET_UPDATE',
} as const;

export type NotificationEventCode = (typeof NotificationEvent)[keyof typeof NotificationEvent];

/** Placeholders allowed in a template body/title for each event (`{{name}}`). Ids and labels only: no personal data. */
export const EVENT_PARAMS: Record<NotificationEventCode, readonly string[]> = {
  JOB_OPPORTUNITY: ['bookingId', 'category', 'area'],
  INTERVIEW_TRIAL_SCHEDULED: ['bookingId', 'scheduleType', 'scheduledAt'],
  BOOKING_CONFIRMED: ['bookingId', 'startDate'],
  PAYMENT_SUCCEEDED: ['bookingId', 'paymentId', 'receiptNumber'],
  PAYMENT_FAILED: ['bookingId', 'paymentId'],
  VERIFICATION_APPROVED: ['checkType'],
  VERIFICATION_REJECTED: ['checkType'],
  REPLACEMENT_UPDATE: ['bookingId', 'replacementId', 'status'],
  TICKET_UPDATE: ['ticketId', 'status'],
};

export interface NotificationOutboxPayload {
  event: NotificationEventCode;
  /** User ids to notify. */
  recipients: string[];
  params: Record<string, string>;
}
