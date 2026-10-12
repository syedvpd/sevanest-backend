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
  RECHECK_DUE: 'RECHECK_DUE',
  /** Customer: a payment was received for a booking that can no longer proceed; staff are reviewing it. */
  PAYMENT_UNDER_REVIEW: 'PAYMENT_UNDER_REVIEW',
  /** Customer: a worker was matched to the request. */
  BOOKING_MATCHED: 'BOOKING_MATCHED',
  /** Customer: the matched worker accepted the opportunity. */
  WORKER_ACCEPTED: 'WORKER_ACCEPTED',
  /** Customer: the matched worker declined; the request is back with staff. */
  WORKER_DECLINED: 'WORKER_DECLINED',
  /** Worker: the customer re-opened matching or recorded an interview outcome. */
  INTERVIEW_OUTCOME: 'INTERVIEW_OUTCOME',
  /** Customer: the worker is confirmed and the booking fee is due. */
  BOOKING_PAYMENT_DUE: 'BOOKING_PAYMENT_DUE',
  BOOKING_STARTED: 'BOOKING_STARTED',
  BOOKING_COMPLETED: 'BOOKING_COMPLETED',
  BOOKING_CANCELLED: 'BOOKING_CANCELLED',
  RATING_RECEIVED: 'RATING_RECEIVED',
  ATTENDANCE_EXCEPTION: 'ATTENDANCE_EXCEPTION',
  TICKET_MESSAGE: 'TICKET_MESSAGE',
  /** Staff (payment.manage): a money problem needs a person. */
  PAYMENT_EXCEPTION_ALERT: 'PAYMENT_EXCEPTION_ALERT',
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
  RECHECK_DUE: ['checkType'],
  PAYMENT_UNDER_REVIEW: ['bookingId', 'paymentId'],
  BOOKING_MATCHED: ['bookingId'],
  WORKER_ACCEPTED: ['bookingId'],
  WORKER_DECLINED: ['bookingId'],
  INTERVIEW_OUTCOME: ['bookingId'],
  BOOKING_PAYMENT_DUE: ['bookingId'],
  BOOKING_STARTED: ['bookingId'],
  BOOKING_COMPLETED: ['bookingId'],
  BOOKING_CANCELLED: ['bookingId'],
  RATING_RECEIVED: ['bookingId'],
  ATTENDANCE_EXCEPTION: ['bookingId'],
  TICKET_MESSAGE: ['ticketId'],
  PAYMENT_EXCEPTION_ALERT: ['exceptionId', 'kind', 'paymentId'],
};

export interface NotificationOutboxPayload {
  event: NotificationEventCode;
  /** User ids to notify. */
  recipients: string[];
  params: Record<string, string>;
}
