/**
 * Approved verification policy values (client decisions of 2026-10-26, D-90, questions Q-123..Q-129). Plain constants: they are
 * approved business values, not environment configuration.
 */

export const REJECTION_CODES = [
  'BLURRY_IMAGE',
  'DOCUMENT_EXPIRED',
  'NAME_MISMATCH',
  'INCOMPLETE_DOCUMENT',
  'INVALID_DOCUMENT_TYPE',
  'SUSPECTED_TAMPERING',
  'UNVERIFIABLE_REFERENCE',
  'CRIMINAL_RECORD_DISQUALIFIED',
  'OTHER',
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Worker-facing wording of each code, as approved. OTHER has none: its remarks are the explanation. */
export const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  BLURRY_IMAGE: 'Document image is blurry or unreadable. Please upload a clear, well-lit photo.',
  DOCUMENT_EXPIRED: 'Document has expired. Please upload a currently valid document.',
  NAME_MISMATCH: 'Name on document does not match the worker profile name.',
  INCOMPLETE_DOCUMENT:
    'Document is cropped or missing the back side. Please capture all pages/sides.',
  INVALID_DOCUMENT_TYPE: 'Uploaded file is not an accepted document type for this check.',
  SUSPECTED_TAMPERING: 'Document appears altered, modified, or damaged.',
  UNVERIFIABLE_REFERENCE:
    'Previous employer reference is unreachable or could not verify employment.',
  CRIMINAL_RECORD_DISQUALIFIED: 'Failed background check criteria.',
  OTHER: 'The document could not be accepted. See the reviewer remarks.',
};

/**
 * Disqualifying codes: the check cannot be resubmitted. The client named CRIMINAL_RECORD_DISQUALIFIED and "FRAUDULENT_DOCUMENT" as
 * examples; the approved list has no FRAUDULENT_DOCUMENT, so SUSPECTED_TAMPERING is treated as that case (to be confirmed).
 */
export const TERMINAL_REJECTION_CODES: ReadonlySet<RejectionCode> = new Set<RejectionCode>([
  'CRIMINAL_RECORD_DISQUALIFIED',
  'SUSPECTED_TAMPERING',
]);

/** Review SLA: 24 business hours from submission; claim SLA 2 hours; a claim with no activity for 30 minutes is released. */
export const REVIEW_SLA_BUSINESS_HOURS = 24;
export const CLAIM_SLA_HOURS = 2;
export const CLAIM_INACTIVITY_MINUTES = 30;

// Business hours: 09:00-19:00 IST, Monday to Saturday (India has no daylight saving: a fixed +05:30 offset).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const OPEN_HOUR = 9;
const CLOSE_HOUR = 19;

function toIst(date: Date): Date {
  return new Date(date.getTime() + IST_OFFSET_MS);
}
function fromIst(ist: Date): Date {
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/** Start of the next opening period at or after `ist` (an IST wall-clock expressed in UTC fields). */
function nextOpening(ist: Date): Date {
  const d = new Date(ist.getTime());
  for (let guard = 0; guard < 8; guard++) {
    const isSunday = d.getUTCDay() === 0;
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    if (!isSunday && hour >= OPEN_HOUR && hour < CLOSE_HOUR) return d;
    if (!isSunday && hour < OPEN_HOUR) {
      d.setUTCHours(OPEN_HOUR, 0, 0, 0);
      return d;
    }
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(OPEN_HOUR, 0, 0, 0);
    if (d.getUTCDay() !== 0) return d;
  }
  return d;
}

/**
 * The instant `hours` business hours after `from`. A start outside business hours counts from the next opening (09:00 IST on the
 * next business day), as approved.
 */
export function addBusinessHours(from: Date, hours: number): Date {
  let cursor = nextOpening(toIst(from));
  let remainingMs = hours * 60 * 60 * 1000;
  for (let guard = 0; guard < 400 && remainingMs > 0; guard++) {
    const closing = new Date(cursor.getTime());
    closing.setUTCHours(CLOSE_HOUR, 0, 0, 0);
    const available = closing.getTime() - cursor.getTime();
    if (remainingMs <= available) {
      return fromIst(new Date(cursor.getTime() + remainingMs));
    }
    remainingMs -= available;
    const next = new Date(cursor.getTime());
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(OPEN_HOUR, 0, 0, 0);
    cursor = nextOpening(next);
  }
  return fromIst(cursor);
}

export type SlaFlag = 'OVERDUE' | 'STALLED_CLAIM';

/** SLA view of one check at `now`. Only checks still waiting for a decision can be flagged. */
export function slaOf(
  check: {
    status: string;
    submittedAt: Date | null;
    claimedAt: Date | null;
    reviewerUserId: string | null;
  },
  now: Date = new Date(),
): { dueAt: Date | null; claimDueAt: Date | null; flags: SlaFlag[] } {
  const waiting = check.status === 'SUBMITTED' || check.status === 'IN_REVIEW';
  const dueAt = check.submittedAt
    ? addBusinessHours(check.submittedAt, REVIEW_SLA_BUSINESS_HOURS)
    : null;
  const claimDueAt =
    check.claimedAt && check.reviewerUserId
      ? new Date(check.claimedAt.getTime() + CLAIM_SLA_HOURS * 60 * 60 * 1000)
      : null;
  const flags: SlaFlag[] = [];
  if (waiting && dueAt && now.getTime() > dueAt.getTime()) flags.push('OVERDUE');
  if (check.status === 'IN_REVIEW' && claimDueAt && now.getTime() > claimDueAt.getTime()) {
    flags.push('STALLED_CLAIM');
  }
  return { dueAt, claimDueAt, flags };
}

/** "XXXX-XXXX-1234": only the last four letters or digits survive; the full number is never kept. null when there are fewer than 4. */
export function maskDocumentNumber(raw: string): string | null {
  const compact = raw.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length < 4) return null;
  return `XXXX-XXXX-${compact.slice(-4).toUpperCase()}`;
}
