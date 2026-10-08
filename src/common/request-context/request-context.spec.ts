import type { Request, Response } from 'express';
import { ensureRequestId, getRequestId, requestContextMiddleware } from './request-context';

function fakes(headerValue?: string | string[]) {
  const headers: Record<string, string | string[] | undefined> = { 'x-request-id': headerValue };
  const req = { headers } as unknown as Request & { id?: unknown };
  const res = { setHeader: jest.fn() } as unknown as Response & { setHeader: jest.Mock };
  return { req, res };
}

describe('request context', () => {
  it('reuses a well-formed inbound X-Request-Id and echoes it', () => {
    const { req, res } = fakes('client-trace-12345');
    expect(ensureRequestId(req, res)).toBe('client-trace-12345');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'client-trace-12345');
  });

  it('generates a UUID when absent', () => {
    const { req, res } = fakes();
    expect(ensureRequestId(req, res)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    'short',
    'has spaces in it',
    'bad\r\nheader-injection',
    'x'.repeat(200),
    'semi;colon;value',
  ])('replaces an unacceptable inbound id: %j', (bad) => {
    const { req, res } = fakes(bad);
    const id = ensureRequestId(req, res);
    expect(id).not.toBe(bad);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent for one request (logger and middleware both call it)', () => {
    const { req, res } = fakes();
    const first = ensureRequestId(req, res);
    expect(ensureRequestId(req, res)).toBe(first);
    expect(res.setHeader).toHaveBeenCalledTimes(1);
  });

  it('exposes the id to downstream code through AsyncLocalStorage', (done) => {
    const { req, res } = fakes('client-trace-12345');
    expect(getRequestId()).toBeUndefined();
    requestContextMiddleware(req, res, () => {
      expect(getRequestId()).toBe('client-trace-12345');
      done();
    });
  });
});
