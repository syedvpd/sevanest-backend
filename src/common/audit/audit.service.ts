import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { getRequestId } from '../request-context/request-context';
import { AuditRepository } from './audit.repository';
import type { AuditEntryInput, AuditTransaction } from './audit.types';

// Matches whole words in a key after camelCase is split ("refreshToken" -> refresh_token), so "company" is not "pan".
const SENSITIVE_WORD =
  /(^|_)(password|passwd|secret|token|otp|authorization|cookie|apikey|api_key|aadhaar|aadhar|pan|pancard|signature)(_|$)/;

function isSensitiveKey(key: string): boolean {
  const normalised = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return SENSITIVE_WORD.test(normalised);
}
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

export function redactSensitive(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const out: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  // bigint, symbol, function: not representable as JSON; never stringify arbitrary objects.
  return typeof value === 'bigint' ? value.toString() : '[UNSERIALISABLE]';
}

@Injectable()
export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  /**
   * Appends an audit record (actor, role, action, entity, record, timestamp, metadata; PRD §12, FR-SEC-008).
   * Call inside the business transaction and pass `tx` so the record cannot exist without the change, or vice versa.
   */
  async record(entry: AuditEntryInput, tx?: AuditTransaction): Promise<void> {
    const metadata = entry.metadata ? redactSensitive(entry.metadata) : null;
    await this.repository.insert(
      {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        metadata: metadata === null ? undefined : metadata,
        requestId: getRequestId() ?? null,
      },
      tx,
    );
  }
}
