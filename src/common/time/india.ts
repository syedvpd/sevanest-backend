import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';

/** Today in India as YYYY-MM-DD: the calendar that start dates, re-check dates and attendance dates use. */
export function indiaToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30 and 2026-13-01). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Turns two optional India dates (YYYY-MM-DD, inclusive) into the instants that bound them, for filtering by creation time.
 * A date that is not a real calendar date, or a start after the end, is a 400.
 */
export function createdRange(
  from: string | undefined,
  to: string | undefined,
): { createdFrom?: Date; createdTo?: Date } {
  const invalid = (field: string, message: string): DomainException =>
    new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  if (from !== undefined && !isRealDate(from)) throw invalid('createdFrom', 'not a real date');
  if (to !== undefined && !isRealDate(to)) throw invalid('createdTo', 'not a real date');
  if (from !== undefined && to !== undefined && from > to) {
    throw invalid('createdFrom', 'createdFrom must not be after createdTo');
  }
  return {
    ...(from ? { createdFrom: new Date(`${from}T00:00:00.000+05:30`) } : {}),
    ...(to ? { createdTo: new Date(`${to}T23:59:59.999+05:30`) } : {}),
  };
}
