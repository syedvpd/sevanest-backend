import { Prisma } from '../../generated/prisma/client';
import { TERMINAL_REJECTION_CODES } from './verification-policy';

/** Today's date in India: the calendar the re-check dates (FM-05 "expiry / recheck date") are expressed in. */
export const INDIA_TODAY_SQL = Prisma.sql`(now() AT TIME ZONE 'Asia/Kolkata')::date`;

/**
 * D-90: "live in matching" = fully verified (above) AND signed off AND activated by operations. Search and matching use this;
 * the verification-only definition stays for reporting and for the sign-off prerequisite.
 */
export function activeWorkerCondition(workerIdColumn: string): Prisma.Sql {
  if (!ALIAS.test(workerIdColumn)) {
    throw new Error('activeWorkerCondition expects a column reference');
  }
  const worker = Prisma.raw(workerIdColumn);
  return Prisma.sql`(
    ${verifiedWorkerCondition(workerIdColumn)}
    AND EXISTS (
      SELECT 1 FROM worker_profiles aw
      WHERE aw.id = ${worker}
        AND aw.activated_at IS NOT NULL
        AND aw.verification_signed_off_at IS NOT NULL
    )
  )`;
}

/**
 * The verification facts the admin worker list shows, as SQL columns for the worker `workerIdColumn` (a column reference, never user
 * input): verified (the definition above), live (verified AND signed off AND activated), started (any check submitted), rejected
 * (any check rejected) and disqualified (a check rejected with a disqualifying code). Owned here so Workers never re-implements them.
 */
export function verificationFactColumns(workerIdColumn: string): Prisma.Sql {
  if (!ALIAS.test(workerIdColumn)) {
    throw new Error('verificationFactColumns expects a column reference');
  }
  const worker = Prisma.raw(workerIdColumn);
  const terminal = Prisma.join(
    [...TERMINAL_REJECTION_CODES].map((code) => Prisma.sql`${code}::"VerificationRejectionCode"`),
  );
  return Prisma.sql`
    ${verifiedWorkerCondition(workerIdColumn)} AS verified,
    ${activeWorkerCondition(workerIdColumn)} AS live,
    EXISTS (SELECT 1 FROM worker_verification_checks vc WHERE vc.worker_id = ${worker} AND vc.status <> 'NOT_SUBMITTED') AS started,
    EXISTS (SELECT 1 FROM worker_verification_checks vc WHERE vc.worker_id = ${worker} AND vc.status = 'REJECTED') AS rejected,
    EXISTS (SELECT 1 FROM worker_verification_checks vc WHERE vc.worker_id = ${worker} AND vc.status = 'REJECTED' AND vc.rejection_code IN (${terminal})) AS disqualified`;
}

const ALIAS = /^[a-z][a-z_]*(\.[a-z][a-z_]*)?$/;

/**
 * THE definition of "fully verified" in SQL, owned by Verification and embedded by read-side modules (Search, Matching) so
 * they cannot drift from it: at least one check is required, and every required check is APPROVED and not due for re-check
 * (FR-VER-010, FRD section 5). `workerIdColumn` is a column reference such as `wp.id`, never user input.
 */
export function verifiedWorkerCondition(workerIdColumn: string): Prisma.Sql {
  if (!ALIAS.test(workerIdColumn)) {
    throw new Error('verifiedWorkerCondition expects a column reference');
  }
  const worker = Prisma.raw(workerIdColumn);
  return Prisma.sql`(
    EXISTS (SELECT 1 FROM verification_requirements)
    AND NOT EXISTS (
      SELECT 1 FROM verification_requirements vr
      WHERE NOT EXISTS (
        SELECT 1 FROM worker_verification_checks vc
        WHERE vc.worker_id = ${worker}
          AND vc.check_type = vr.check_type
          AND vc.status = 'APPROVED'
          AND (vc.recheck_at IS NULL OR vc.recheck_at > ${INDIA_TODAY_SQL})
      )
    )
  )`;
}
