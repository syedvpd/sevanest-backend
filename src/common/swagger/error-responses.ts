import type { OpenAPIObject } from '@nestjs/swagger';

export const API_ERROR_SCHEMA = 'ApiError';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** The one error body every failure returns (see AllExceptionsFilter). Documented once and referenced from every operation. */
const API_ERROR = {
  type: 'object',
  required: ['code', 'message'],
  properties: {
    code: {
      type: 'string',
      description:
        'Stable machine-readable code. Platform codes: BAD_REQUEST, VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, PAYLOAD_TOO_LARGE, RATE_LIMITED, INTERNAL_ERROR, SERVICE_UNAVAILABLE. Modules add their own domain codes (for example INVALID_TRANSITION, OTP_INVALID, ADDRESS_LIMIT_REACHED).',
    },
    message: {
      type: 'string',
      description: 'Safe, human-readable text. Never contains SQL, paths, secrets or stack traces.',
    },
    details: {
      type: 'array',
      description: 'Per-field problems, present on VALIDATION_FAILED and some domain errors.',
      items: {
        type: 'object',
        required: ['field', 'messages'],
        properties: {
          field: { type: 'string' },
          messages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    requestId: {
      type: 'string',
      description: 'Also sent as the x-request-id response header; quote it to support.',
    },
  },
} as const;

function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${API_ERROR_SCHEMA}` } },
    },
  };
}

/**
 * Adds the standard error responses to every operation that does not already document them, and the shared `ApiError` schema.
 * Which statuses an operation can really return is derived from its declaration: 400 when it takes input, 401/403 when it is
 * protected, 404 when it addresses one resource, 429 unless it is a health probe, and 500/503 for every API operation. Domain-specific
 * statuses (409, 422 and their codes) stay documented by the operation itself.
 */
export function addStandardErrorResponses(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas[API_ERROR_SCHEMA] = API_ERROR as never;

  for (const [path, item] of Object.entries(document.paths)) {
    const isHealth = path.startsWith('/health');
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const parameters = (operation.parameters ?? []) as Array<{ in?: string }>;
      const takesInput =
        operation.requestBody !== undefined ||
        parameters.some((p) => p.in === 'query' || p.in === 'path') ||
        path.includes('{');
      const secured = (operation.security ?? []).length > 0;
      const wanted: Array<[string, string]> = [];
      if (takesInput)
        wanted.push([
          '400',
          'The request is malformed or failed validation (VALIDATION_FAILED, BAD_REQUEST).',
        ]);
      if (secured) {
        wanted.push([
          '401',
          'Missing, invalid, expired or revoked access token (UNAUTHENTICATED).',
        ]);
        wanted.push([
          '403',
          'The account type, role or permission does not allow this (FORBIDDEN), or the account is suspended.',
        ]);
      }
      if (path.includes('{'))
        wanted.push(['404', 'No such resource, or it belongs to someone else (NOT_FOUND).']);
      if (!isHealth) wanted.push(['429', 'Too many requests (RATE_LIMITED); retry later.']);
      if (!isHealth)
        wanted.push([
          '500',
          'Unexpected server error (INTERNAL_ERROR); the body carries a requestId.',
        ]);
      if (path !== '/health/live') {
        wanted.push([
          '503',
          'A dependency (database, Redis or a provider) is unavailable (SERVICE_UNAVAILABLE); safe to retry.',
        ]);
      }
      operation.responses ??= {};
      for (const [status, description] of wanted) {
        operation.responses[status] ??= errorResponse(description) as never;
      }
      // An error an operation documents itself (for example a domain 409 or 422) still carries the standard body.
      for (const [status, response] of Object.entries(operation.responses)) {
        const declared = response as { content?: unknown; description?: string };
        if (Number(status) >= 400 && !declared.content) {
          declared.content = (errorResponse('') as { content: unknown }).content;
        }
      }
    }
  }
  return document;
}
