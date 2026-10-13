import * as Sentry from '@sentry/node';

/**
 * Error monitoring (Sentry). Off unless SENTRY_DSN is set, so local and CI runs send nothing. Called first in `main.ts` and `worker.ts`.
 * Personal data never leaves the process: request bodies, cookies or authorization headers are attached, and user
 * identifiers are not set.
 */
export function initSentry(service: 'api' | 'worker'): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  const rate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT,
    serverName: service,
    tracesSampleRate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0,
    initialScope: { tags: { service } },
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        delete event.request.headers;
        delete event.request.query_string;
      }
      delete event.user;
      return event;
    },
  });
}

/** Reports an unexpected server error (HTTP 5xx or a failed background job). A no-op when Sentry is not configured. */
export function reportError(error: unknown, context?: Record<string, string>): void {
  if (!Sentry.isEnabled()) return;
  Sentry.withScope((scope) => {
    if (context) scope.setTags(context);
    Sentry.captureException(error);
  });
}

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (Sentry.isEnabled()) await Sentry.flush(timeoutMs);
}
