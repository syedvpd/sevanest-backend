import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception';

export const STALE_VERSION = 'STALE_VERSION';

/** The ETag of a record: its last-change instant. Opaque to clients, who send back what GET returned. */
export function etagOf(updatedAt: Date): string {
  return `"${updatedAt.getTime()}"`;
}

/**
 * Optimistic concurrency for admin edits (FRD FM-14: "last change flagged or blocked"). With an `If-Match` header the edit is applied only
 * if the record is still the version the admin looked at; otherwise 412 STALE_VERSION and nothing changes. Without the header the edit
 * behaves as before. `*` always matches. Call it while the row is locked.
 */
export function assertIfMatch(header: string | undefined, updatedAt: Date): void {
  if (header === undefined || header.trim() === '*') return;
  const wanted = header
    .split(',')
    .map((v) => v.trim().replace(/^W\//, ''))
    .filter(Boolean);
  if (!wanted.includes(etagOf(updatedAt))) {
    throw new DomainException(
      STALE_VERSION,
      'This record changed since you loaded it: reload and try again',
      HttpStatus.PRECONDITION_FAILED,
    );
  }
}
