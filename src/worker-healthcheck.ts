import Redis from 'ioredis';

/**
 * Container health probe for the worker process (it has no HTTP server): exits 0 when the worker's notification loop wrote its
 * heartbeat in Redis within the heartbeat lifetime (180 s, the loop ticks every few seconds), 1 otherwise. Run as
 * `node dist/worker-healthcheck.js` (compose `healthcheck`, a Kubernetes exec probe). It reads one key and writes nothing.
 */
const KEY = 'worker:heartbeat:notifications';

async function main(): Promise<number> {
  const url = process.env.REDIS_URL;
  if (!url) return 1;
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    return (await redis.exists(KEY)) === 1 ? 0 : 1;
  } catch {
    return 1;
  } finally {
    redis.disconnect();
  }
}

void main().then((code) => process.exit(code));
setTimeout(() => process.exit(1), 5000).unref();
