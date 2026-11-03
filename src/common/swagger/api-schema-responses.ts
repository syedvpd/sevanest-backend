import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiProduces, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { PageMetaView } from './api-responses';

/** A JSON-schema fragment (OpenAPI 3.0). The Swagger types are not exported from the package root, so it is kept loose. */
export type SchemaObject = Record<string, unknown>;

/**
 * Response documentation for handlers that return a plain object, a file or a string instead of a decorated class. The schema is the
 * shape the handler really returns; the contract suite validates documented models against live responses.
 */
export function ApiSchemaResponse(
  schema: SchemaObject,
  description: string,
  status = 200,
): MethodDecorator {
  return ApiResponse({ status, description, schema });
}

/** `{ data: Item[], meta: { page, limit, total } }` where the item is described inline. */
export function ApiPageOfSchema(item: SchemaObject, description: string): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(PageMetaView),
    ApiResponse({
      status: 200,
      description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: { type: 'array', items: item },
          meta: { $ref: getSchemaPath(PageMetaView) },
        },
      },
    }),
  );
}

/** A model that may be `null` (for example "my open request, or null"). */
export function ApiNullableModelResponse(
  model: Type<unknown>,
  description: string,
): MethodDecorator {
  return applyDecorators(
    ApiExtraModels(model),
    ApiResponse({
      status: 200,
      description,
      schema: { nullable: true, allOf: [{ $ref: getSchemaPath(model) }] },
    }),
  );
}

/** A file download: the body is bytes of `contentType` (a PDF receipt, a CSV export). */
export function ApiFileResponse(contentType: string, description: string): MethodDecorator {
  return applyDecorators(
    ApiProduces(contentType),
    ApiResponse({
      status: 200,
      description,
      content: { [contentType]: { schema: { type: 'string', format: 'binary' } } },
    }),
  );
}

const int = { type: 'integer' } as const;

/** `{ photoId, status: 'READY' }` after a profile photo upload is confirmed. */
export const PHOTO_CONFIRMED_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['photoId', 'status'],
  properties: {
    photoId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['READY'] },
  },
};

/** A payment exception (money that needs a person), as `GET /admin/payment-exceptions` returns it. */
export const PAYMENT_EXCEPTION_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'kind', 'status', 'requiredAction', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: {
      type: 'string',
      description: 'Why a person is needed, for example REFUND_STUCK or AMOUNT_MISMATCH.',
    },
    status: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
    paymentId: { type: 'string', format: 'uuid', nullable: true },
    bookingId: { type: 'string', format: 'uuid', nullable: true },
    bookingStatus: { type: 'string', nullable: true },
    paymentStatus: { type: 'string', nullable: true },
    amountMinor: {
      ...int,
      nullable: true,
      description: 'Amount in the smallest currency unit (paise).',
    },
    currency: { type: 'string', nullable: true },
    providerOrderId: { type: 'string', nullable: true },
    providerPaymentId: { type: 'string', nullable: true },
    requiredAction: { type: 'string' },
    details: { type: 'object', additionalProperties: true, nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    resolvedAt: { type: 'string', format: 'date-time', nullable: true },
    resolvedByUserId: { type: 'string', format: 'uuid', nullable: true },
    resolutionNote: { type: 'string', nullable: true },
  },
};

export const ALERT_SUMMARY_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['open', 'bySeverity'],
  properties: {
    open: int,
    bySeverity: {
      type: 'object',
      additionalProperties: int,
      description: 'Open alerts per severity.',
    },
  },
};

export const NOTIFICATION_HEALTH_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['notifications', 'outbox', 'queue'],
  properties: {
    notifications: {
      type: 'object',
      required: ['byStatus', 'oldestQueuedSeconds'],
      properties: {
        byStatus: {
          type: 'object',
          additionalProperties: int,
          description: 'QUEUED, SENT, FAILED, SKIPPED.',
        },
        oldestQueuedSeconds: { ...int, nullable: true },
      },
    },
    outbox: {
      type: 'object',
      required: ['pending', 'oldestPendingSeconds', 'deadLettered'],
      properties: {
        pending: int,
        oldestPendingSeconds: { ...int, nullable: true },
        deadLettered: int,
      },
    },
    queue: {
      type: 'object',
      nullable: true,
      description: 'Null when Redis is unreachable.',
      properties: { waiting: int, active: int, delayed: int, failed: int },
    },
  },
};

export const READINESS_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['ready', 'blockers', 'warnings', 'checks', 'workers'],
  properties: {
    ready: { type: 'boolean', description: 'False while any BLOCKER check fails.' },
    blockers: int,
    warnings: int,
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'level', 'ok', 'message'],
        properties: {
          key: { type: 'string' },
          level: { type: 'string', enum: ['BLOCKER', 'WARNING'] },
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
    },
    workers: {
      type: 'array',
      nullable: true,
      description: 'Background loops with their last heartbeat; null when Redis is unreachable.',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, lastSeen: { type: 'string', format: 'date-time' } },
      },
    },
  },
};

export const RETENTION_REPORT_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['dryRun', 'tasks', 'deletions'],
  properties: {
    dryRun: { type: 'boolean' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'matched', 'affected'],
        properties: {
          name: { type: 'string' },
          matched: int,
          affected: int,
          failed: { type: 'boolean' },
        },
      },
    },
    deletions: {
      type: 'object',
      additionalProperties: true,
      description: 'Account anonymisation counts.',
    },
  },
};

export const DASHBOARD_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['generatedAt', 'sections'],
  properties: {
    generatedAt: { type: 'string', format: 'date-time' },
    sections: {
      type: 'object',
      description:
        'Only the sections the caller may see are present; an admin with none gets an empty object.',
      properties: {
        bookings: {
          type: 'object',
          properties: {
            byStatus: {
              type: 'array',
              items: { type: 'object', properties: { status: { type: 'string' }, count: int } },
            },
          },
        },
        workers: { type: 'object', properties: { registered: int, verifiedAndActive: int } },
        pendingKyc: { type: 'object', properties: { submitted: int, inReview: int } },
        complaints: {
          type: 'object',
          properties: { open: int, inProgress: int, escalated: int, unassigned: int },
        },
        replacements: { type: 'object', properties: { requested: int, approved: int } },
        collections: {
          type: 'array',
          items: {
            type: 'object',
            properties: { currency: { type: 'string' }, todayMinor: int, monthToDateMinor: int },
          },
        },
        alerts: { type: 'object', properties: { open: int, critical: int, warning: int } },
      },
    },
  },
};
