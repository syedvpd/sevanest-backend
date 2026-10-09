import type { ReportCatalogEntry } from './dto/reports.dto';

const BASE = '/api/v1/admin/reports';

const STATE_MODEL =
  'Booking states are the PROPOSED FRD section 4 model (C-02, Q-55); a change to the state model changes these numbers.';
const NO_FORECAST = 'Counts only what is recorded; nothing is estimated or back-filled.';

/**
 * The twelve reports of PRD section 14 / SRS FR-RPT-001..012 with the PROPOSED definitions of FRD section 7. Every definition
 * is stated in the response itself, so a reader never has to guess what a number means. Nothing here is a confirmed business
 * definition (Q-61).
 */
export const REPORT_CATALOG: readonly ReportCatalogEntry[] = [
  {
    report: 'new-customers',
    requirement: 'FR-RPT-001',
    path: `${BASE}/new-customers`,
    definition:
      'Customer accounts created per day/week/month (a customer registers when the first OTP login creates the account).',
    notes: ['Counts accounts, not completed profiles.', NO_FORECAST],
  },
  {
    report: 'worker-registrations',
    requirement: 'FR-RPT-002',
    path: `${BASE}/worker-registrations`,
    definition:
      'Worker profiles created in the period, and how many of those workers are fully verified today (verified / registered).',
    notes: [
      'Verified is evaluated now, not at the end of the period, so older periods rise as workers get verified.',
      '"Verified" is the Verification module definition: every required check approved and not due for re-check, with at least one required check configured.',
    ],
  },
  {
    report: 'booking-funnel',
    requirement: 'FR-RPT-003',
    path: `${BASE}/booking-funnel`,
    definition:
      'Booking requests created in the period, and how many of those requests reached CONFIRMED at any point.',
    notes: [
      STATE_MODEL,
      'A confirmed booking that was later replaced or cancelled still counts as confirmed.',
    ],
  },
  {
    report: 'demand-by-category',
    requirement: 'FR-RPT-004',
    path: `${BASE}/demand-by-category`,
    definition: 'Booking requests created in the period, grouped by service category.',
    notes: ['Every category appears, including those with no requests.'],
  },
  {
    report: 'demand-by-area',
    requirement: 'FR-RPT-005',
    path: `${BASE}/demand-by-area`,
    definition:
      'Booking requests created in the period, grouped by service area (paginated, busiest first).',
    notes: [
      'Only areas with at least one request appear. The booking area is a service-area master entry (Q-47).',
    ],
  },
  {
    report: 'worker-utilization',
    requirement: 'FR-RPT-006',
    path: `${BASE}/worker-utilization`,
    definition:
      'Share of fully verified, active, submitted workers who hold an ACTIVE booking right now.',
    notes: [
      'A point-in-time snapshot: it takes no period and cannot be reproduced for a past date.',
    ],
  },
  {
    report: 'interview-conversion',
    requirement: 'FR-RPT-007',
    path: `${BASE}/interview-conversion`,
    definition:
      'Of the bookings created in the period that completed an interview/trial, the share that reached CONFIRMED (confirmed / interviews held).',
    notes: [
      STATE_MODEL,
      'Cohort by booking creation date, so the numerator and denominator describe the same bookings.',
    ],
  },
  {
    report: 'cancellation-rate',
    requirement: 'FR-RPT-008',
    path: `${BASE}/cancellation-rate`,
    definition:
      'Bookings created in the period that are CANCELLED now, divided by all bookings created in the period.',
    notes: [
      STATE_MODEL,
      'A booking cancelled after the period ends still counts against the period it was created in.',
    ],
  },
  {
    report: 'replacement-rate',
    requirement: 'FR-RPT-009',
    path: `${BASE}/replacement-rate`,
    definition:
      'Replacement requests raised for the bookings created in the period that reached ACTIVE, divided by those bookings.',
    notes: [
      STATE_MODEL,
      'The specs say "active/completed bookings"; every booking that completed was active first, so the ACTIVE cohort covers both.',
    ],
  },
  {
    report: 'payment-collections',
    requirement: 'FR-RPT-010',
    path: `${BASE}/payment-collections`,
    definition:
      'Payments that were paid in the period, by period and fee type: count, gross amount, and the part later refunded. Amounts are in the smallest currency unit.',
    notes: [
      'Gross includes payments refunded afterwards; refunded is shown separately. Partial refunds do not exist yet (Q-56).',
      'Fee types are the configured fee codes; none are invented.',
    ],
  },
  {
    report: 'support-tickets',
    requirement: 'FR-RPT-011',
    path: `${BASE}/support-tickets`,
    definition:
      'Tickets created in the period by status, and the average time from creation to closure of those that are closed.',
    notes: [
      'No SLA target exists, so there is no breach count (Q-59).',
      'Average resolution time ignores tickets still open.',
    ],
  },
  {
    report: 'top-rated-workers',
    requirement: 'FR-RPT-012',
    path: `${BASE}/top-rated-workers`,
    definition:
      'Workers ranked by average visible rating, then by number of ratings, then by worker id (paginated).',
    notes: [
      'All-time totals: ratings are not dated in the summary, so this report takes no period.',
      'No minimum number of ratings is defined (Q-61); use minRatings to set one per request.',
    ],
  },
  {
    report: 'repeat-customers',
    requirement: 'FR-RPT-012',
    path: `${BASE}/repeat-customers`,
    definition:
      'Customers who created more than one booking in the period, most bookings first (paginated).',
    notes: ['Every booking request counts, including cancelled ones (Q-61).'],
  },
];
