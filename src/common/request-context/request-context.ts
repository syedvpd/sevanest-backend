import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Accept only conservative caller-supplied IDs so they cannot inject into logs or headers. */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

interface RequestContextStore {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

type RequestWithId = Request & { id?: unknown };

/**
 * Resolves the correlation ID once per request: reuse a well-formed inbound X-Request-Id (set at the edge),
 * otherwise generate one. Idempotent, so the logger and the middleware can both call it.
 */
export function ensureRequestId(req: RequestWithId, res: Response): string {
  if (typeof req.id === 'string' && req.id.length > 0) {
    return req.id;
  }
  const inbound = req.headers['x-request-id'];
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  const id = candidate && ACCEPTABLE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = ensureRequestId(req, res);
  storage.run({ requestId }, next);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
