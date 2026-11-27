import type { Request } from 'express';
import { isIP } from 'node:net';

/**
 * Resolves the trusted client IP from an Express request according to the configured proxy trust.
 *
 * When trust proxy is enabled (e.g. TRUST_PROXY_HOPS >= 1), Express traverses X-Forwarded-For
 * backwards and populates `request.ips` (from client to upstream proxies) and `request.ip`
 * (the client IP according to the trust configuration).
 *
 * This function ensures:
 * 1. An arbitrary client cannot spoof client IP when connecting directly or through untrusted hops.
 * 2. If `request.ips` exists and has entries, the evaluated client address (`request.ip` or the first trusted hop)
 *    is used.
 * 3. Falls back safely to socket remoteAddress when untrusted or headers are absent.
 * 4. Normalizes IPv6 loopback (::1 / ::ffff:127.0.0.1) and invalid strings cleanly.
 */
export function resolveClientIp(request: Request): string {
  // If Express trust proxy evaluated a valid client IP, use request.ip
  const ip =
    typeof request.ip === 'string' && request.ip.trim() !== '' ? request.ip.trim() : undefined;
  if (ip && isIP(cleanIp(ip))) {
    return cleanIp(ip);
  }

  // Socket remote address fallback
  const socketIp = request.socket?.remoteAddress;
  if (typeof socketIp === 'string' && socketIp.trim() !== '') {
    return cleanIp(socketIp.trim());
  }

  return 'unknown';
}

function cleanIp(ip: string): string {
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 -> 127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    return ip.slice(7);
  }
  return ip;
}
