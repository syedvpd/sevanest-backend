import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Accept only conservative caller-supplied IDs so they cannot inject into logs or headers. */
const ACCEPTABLE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

interface RequestContextStore {
  requestId: string;
  /** Database statements issued while serving this request (only filled when REQUEST_TIMING_LOG is on). */
  queries: number;
  dbMs: number;
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
  storage.run({ requestId, queries: 0, dbMs: 0 }, next);
}

/** Counts one database statement against the current request (no-op outside a request). Never records SQL text or parameters. */
export function recordQuery(durationMs: number): void {
  const store = storage.getStore();
  if (!store) return;
  store.queries += 1;
  store.dbMs += durationMs;
}

export function getRequestStats(): { queries: number; dbMs: number } | undefined {
  const store = storage.getStore();
  return store ? { queries: store.queries, dbMs: Math.round(store.dbMs * 10) / 10 } : undefined;
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Opt-in (REQUEST_TIMING_LOG): one line per finished request with the route TEMPLATE (never the concrete URL or query string),
 * status, wall time and the database work done for it. Carries the request id so a slow or failed call can be matched to the
 * error log line of the same id.
 */
export function requestTimingMiddleware(
  logger: Pick<Logger, 'log'> = new Logger('RequestTiming'),
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const stats = getRequestStats();
      const route = (req.route as { path?: string } | undefined)?.path;
      logger.log({
        msg: 'request',
        requestId: (req as Request & { id?: unknown }).id,
        method: req.method,
        route: route ? `${req.baseUrl}${route}` : 'unmatched',
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
        queries: stats?.queries ?? 0,
        dbMs: stats?.dbMs ?? 0,
      });
    });
    next();
  };
}
