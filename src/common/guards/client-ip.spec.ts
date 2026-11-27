import type { Request } from 'express';
import { resolveClientIp } from './client-ip';

describe('resolveClientIp', () => {
  it('extracts request.ip when set by Express trust proxy', () => {
    const req = {
      ip: '203.0.113.195',
      ips: ['203.0.113.195'],
      socket: { remoteAddress: '10.0.0.1' },
    } as unknown as Request;

    expect(resolveClientIp(req)).toBe('203.0.113.195');
  });

  it('normalizes IPv4-mapped IPv6 address from request.ip', () => {
    const req = {
      ip: '::ffff:198.51.100.22',
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    } as unknown as Request;

    expect(resolveClientIp(req)).toBe('198.51.100.22');
  });

  it('falls back to socket.remoteAddress when request.ip is empty or invalid', () => {
    const req = {
      ip: '',
      socket: { remoteAddress: '198.51.100.55' },
    } as unknown as Request;

    expect(resolveClientIp(req)).toBe('198.51.100.55');
  });

  it('returns unknown when neither request.ip nor socket.remoteAddress is present', () => {
    const req = {
      ip: undefined,
      socket: {},
    } as unknown as Request;

    expect(resolveClientIp(req)).toBe('unknown');
  });

  it('preserves legitimate IPv6 address', () => {
    const req = {
      ip: '2001:db8::1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    expect(resolveClientIp(req)).toBe('2001:db8::1');
  });
});
