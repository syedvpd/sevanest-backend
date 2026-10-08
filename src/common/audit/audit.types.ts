import type { Prisma } from '../../generated/prisma/client';

export interface AuditEntryInput {
  /** Verb-style action, e.g. 'verification.approve'. */
  action: string;
  entityType: string;
  entityId?: string;
  actorId?: string | null;
  actorRole?: string | null;
  /** Free-form context. Secrets/PII-like keys are redacted before storage. Never put identity documents here. */
  metadata?: Record<string, unknown>;
}

/** Pass the surrounding transaction so the audit row commits atomically with the change it describes (BEA p6). */
export type AuditTransaction = Prisma.TransactionClient;
