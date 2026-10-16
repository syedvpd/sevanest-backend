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
  /** Customer: the booking was cancelled and the refund was started automatically (DEC-04). */
  PAYMENT_REFUND_INITIATED: 'PAYMENT_REFUND_INITIATED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
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
  /** Customer: the worker proposed a different interview/trial time. */
  BOOKING_SLOT_PROPOSED: 'BOOKING_SLOT_PROPOSED',
  /** Worker: the customer requested (or re-requested) an interview or trial time. */
  INTERVIEW_REQUESTED: 'INTERVIEW_REQUESTED',
  /** Customer: the worker answered an interview/trial request (declined, proposed another time) or the customer kept the time. */
  INTERVIEW_RESPONDED: 'INTERVIEW_RESPONDED',
  /** The other party cancelled an interview or trial. */
  INTERVIEW_CANCELLED: 'INTERVIEW_CANCELLED',
  /** Worker: the customer answered the proposed time. */
  BOOKING_SLOT_ANSWERED: 'BOOKING_SLOT_ANSWERED',
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
  PAYMENT_REFUND_INITIATED: ['bookingId', 'paymentId'],
  PAYMENT_REFUNDED: ['bookingId', 'paymentId'],
  BOOKING_MATCHED: ['bookingId'],
  WORKER_ACCEPTED: ['bookingId'],
  WORKER_DECLINED: ['bookingId'],
  INTERVIEW_OUTCOME: ['bookingId'],
  BOOKING_PAYMENT_DUE: ['bookingId'],
  BOOKING_STARTED: ['bookingId'],
  BOOKING_COMPLETED: ['bookingId'],
  BOOKING_CANCELLED: ['bookingId'],
  BOOKING_SLOT_PROPOSED: ['bookingId', 'proposedAt'],
  INTERVIEW_REQUESTED: ['bookingId', 'interviewId'],
  INTERVIEW_RESPONDED: ['bookingId', 'interviewId', 'answer'],
  INTERVIEW_CANCELLED: ['bookingId', 'interviewId'],
  BOOKING_SLOT_ANSWERED: ['bookingId', 'answer'],
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
