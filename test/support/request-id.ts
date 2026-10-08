import type { Request, Response } from 'express';
import { requestContextMiddleware } from '../../src/common/request-context/request-context';

/** Runs `work` inside a request context carrying `requestId`, as the real middleware would. */
export function runWithTestRequestId<T>(requestId: string, work: () => Promise<T>): Promise<T> {
  const req = { headers: { 'x-request-id': requestId } } as unknown as Request;
  const res = { setHeader: () => undefined } as unknown as Response;
  return new Promise<T>((resolve, reject) => {
    requestContextMiddleware(req, res, () => {
      work().then(resolve, reject);
    });
  });
}
