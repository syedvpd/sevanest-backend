import { ProviderError } from '../provider-error';

export interface ProviderHttpResponse {
  status: number;
  json: unknown;
}

/**
 * One outbound HTTPS call to an external provider (SMS, payment gateway). The only place that classifies transport failures:
 * a timeout, a network error, HTTP 429 and 5xx are retryable; any other non-2xx is a permanent rejection (bad request or bad
 * credentials). Error messages carry the provider name and status only - never the request (it may hold an OTP, a phone number
 * or a secret) and never the response body.
 */
export async function providerRequest(
  provider: string,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<ProviderHttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ProviderError(
      provider,
      timedOut ? `${provider} request timed out` : `${provider} is unreachable`,
      true,
    );
  }
  const json = await response.text().then(
    (text): unknown => {
      try {
        return text.length > 0 ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    },
    (): unknown => null,
  );
  if (response.status === 429 || response.status >= 500) {
    throw new ProviderError(provider, `${provider} answered HTTP ${response.status}`, true);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProviderError(
      provider,
      `${provider} rejected the request (HTTP ${response.status})`,
      false,
      { status: response.status, json },
    );
  }
  return { status: response.status, json };
}

export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`;
}
