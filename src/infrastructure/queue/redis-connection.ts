import type { ConnectionOptions } from 'bullmq';

/** Translates a redis:// or rediss:// URL into BullMQ connection options (BullMQ workers require unlimited retries). */
export function redisConnectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const dbSegment = parsed.pathname.replace('/', '');
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    db: dbSegment ? Number(dbSegment) : undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
