import type { NotificationEventCode } from '../../common/outbox/notification-events';

/**
 * Starter wording for the in-app inbox, installed by `npm run seed:launch` only where an administrator has not written a template
 * yet (an existing template is never overwritten). The wording is deliberately plain and neutral: it is a placeholder for the
 * business to review (FRD leaves message wording open) - not approved copy. IN_APP is the one channel that needs no external provider.
 * Placeholders must be ones the event provides (checked by a unit test).
 */
export const DEFAULT_IN_APP_TEMPLATES: ReadonlyArray<{
  event: NotificationEventCode;
  title: string;
  body: string;
}> = [
  {
    event: 'JOB_OPPORTUNITY',
    title: 'New job opportunity',
    body: 'A new {{category}} job in {{area}} is waiting for your response.',
  },
  {
    event: 'INTERVIEW_TRIAL_SCHEDULED',
    title: 'Interview or trial scheduled',
    body: 'A {{scheduleType}} is scheduled for {{scheduledAt}}.',
  },
  {
    event: 'BOOKING_CONFIRMED',
    title: 'Booking confirmed',
    body: 'Your booking is confirmed. Start date: {{startDate}}.',
  },
  {
    event: 'PAYMENT_SUCCEEDED',
    title: 'Payment received',
    body: 'Your payment was received. Receipt: {{receiptNumber}}.',
  },
  {
    event: 'PAYMENT_FAILED',
    title: 'Payment failed',
    body: 'Your payment did not go through. You can try again from the booking.',
  },
  {
    event: 'PAYMENT_UNDER_REVIEW',
    title: 'Payment under review',
    body: 'We received a payment for a booking that can no longer go ahead. Our team is reviewing it and will contact you.',
  },
  {
    event: 'VERIFICATION_APPROVED',
    title: 'Verification approved',
    body: 'Your {{checkType}} verification was approved.',
  },
  {
    event: 'VERIFICATION_REJECTED',
    title: 'Verification needs attention',
    body: 'Your {{checkType}} verification was not approved. Please check the remarks and resubmit.',
  },
  {
    event: 'REPLACEMENT_UPDATE',
    title: 'Replacement update',
    body: 'Your replacement request is now {{status}}.',
  },
  {
    event: 'TICKET_UPDATE',
    title: 'Support update',
    body: 'Your support request is now {{status}}.',
  },
  {
    event: 'TICKET_MESSAGE',
    title: 'New message on your support request',
    body: 'Our team replied to your support request.',
  },
  {
    event: 'RECHECK_DUE',
    title: 'Verification re-check due',
    body: 'Your {{checkType}} verification is due for a re-check.',
  },
  {
    event: 'BOOKING_MATCHED',
    title: 'Worker matched',
    body: 'A worker has been matched to your request.',
  },
  {
    event: 'WORKER_ACCEPTED',
    title: 'Worker accepted',
    body: 'The matched worker accepted your request.',
  },
  {
    event: 'WORKER_DECLINED',
    title: 'Worker unavailable',
    body: 'The matched worker is not available. We will find another worker for you.',
  },
  {
    event: 'INTERVIEW_OUTCOME',
    title: 'Interview update',
    body: 'The outcome of your interview or trial was recorded.',
  },
  {
    event: 'BOOKING_PAYMENT_DUE',
    title: 'Payment due',
    body: 'Your worker is confirmed. Please pay the booking fee to complete the booking.',
  },
  { event: 'BOOKING_STARTED', title: 'Service started', body: 'The service has started.' },
  {
    event: 'BOOKING_COMPLETED',
    title: 'Service completed',
    body: 'The service is marked completed. You can now rate it.',
  },
  { event: 'BOOKING_CANCELLED', title: 'Booking cancelled', body: 'A booking was cancelled.' },
  { event: 'RATING_RECEIVED', title: 'New rating', body: 'You received a new rating.' },
  {
    event: 'ATTENDANCE_EXCEPTION',
    title: 'Attendance exception',
    body: 'An attendance exception was recorded for a booking.',
  },
];
