import { createSign } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { providerRequest } from '../http/provider-http';
import { ProviderError } from '../provider-error';
import {
  InvalidDeviceTokenError,
  type PushProvider,
  type SendResult,
} from './notification-providers.interface';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface FcmSettings {
  serviceAccount: FcmServiceAccount;
  timeoutMs: number;
  /** Test seams; production uses Google's hosts. */
  fcmBaseUrl?: string;
  tokenUrl?: string;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Parses the service-account JSON from the environment. Throws a message that never contains the key. */
export function parseFcmServiceAccount(json: string): FcmServiceAccount {
  let parsed: Partial<FcmServiceAccount>;
  try {
    parsed = JSON.parse(json) as Partial<FcmServiceAccount>;
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key?.includes('PRIVATE KEY')) {
    throw new Error(
      'FCM_SERVICE_ACCOUNT_JSON must contain project_id, client_email and private_key of a service account',
    );
  }
  return parsed as FcmServiceAccount;
}

/**
 * FCM HTTP v1 errors that mean the registration token itself is dead: HTTP 404 / errorCode UNREGISTERED, or HTTP 400
 * INVALID_ARGUMENT whose message names the registration token. Any other 4xx (bad credentials, bad payload, wrong sender) is a
 * permanent failure of the request, not proof that the token is bad, so the binding is kept.
 */
export function isInvalidTokenRejection(error: ProviderError): boolean {
  const cause = error.cause as { status?: number; json?: unknown } | undefined;
  if (!cause || error.retryable) return false;
  const body = cause.json as
    | { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } }
    | null
    | undefined;
  if (body?.error?.details?.some((d) => d?.errorCode === 'UNREGISTERED')) return true;
  if (cause.status === 404) return true;
  return (
    cause.status === 400 &&
    body?.error?.status === 'INVALID_ARGUMENT' &&
    /registration token/i.test(body.error.message ?? '')
  );
}

const b64url = (value: Buffer | string): string => Buffer.from(value).toString('base64url');

/**
 * Firebase Cloud Messaging HTTP v1 (PRD 11: push through FCM). Authenticates with a Google service account: a short-lived RS256 JWT
 * is exchanged for an OAuth access token (cached until shortly before it expires), then each push is POSTed to
 * `/v1/projects/{project}/messages:send`. A token FCM no longer knows (UNREGISTERED / invalid) is a permanent rejection, not a retry.
 * The private key and access token exist only in this object and never appear in an error message. Verified against faked responses
 * only - not against Google.
 */
@Injectable()
export class FcmPushProvider implements PushProvider {
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly settings: FcmSettings) {}

  async sendPush(input: {
    deviceToken: string;
    title: string;
    body: string;
    data?: Record<string, string>;
  }): Promise<SendResult> {
    const send = async (token: string): Promise<{ name?: unknown } | null> => {
      const base = this.settings.fcmBaseUrl ?? 'https://fcm.googleapis.com';
      const { json } = await providerRequest(
        'fcm',
        `${base}/v1/projects/${encodeURIComponent(this.settings.serviceAccount.project_id)}/messages:send`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: input.deviceToken,
              notification: { title: input.title, body: input.body },
              // FCM data values must be strings; routing ids only, never personal data.
              data: input.data ?? {},
            },
          }),
        },
        this.settings.timeoutMs,
      );
      return json as { name?: unknown } | null;
    };
    let reply: { name?: unknown } | null;
    try {
      try {
        reply = await send(await this.token());
      } catch (error) {
        // An expired or revoked access token: fetch a fresh one once and retry.
        if (error instanceof ProviderError && !error.retryable && this.isUnauthorized(error)) {
          this.accessToken = null;
          reply = await send(await this.token());
        } else {
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError && isInvalidTokenRejection(error)) {
        // Keep the status only: the cause also holds the response body.
        throw new InvalidDeviceTokenError('fcm', {
          status: (error.cause as { status?: number }).status,
        });
      }
      throw error;
    }
    if (typeof reply?.name !== 'string') {
      throw new ProviderError('fcm', 'fcm did not accept the message', false);
    }
    return { providerMessageId: reply.name };
  }

  private isUnauthorized(error: ProviderError): boolean {
    return (error.cause as { status?: number } | undefined)?.status === 401;
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > now)
      return this.accessToken.value;
    const account = this.settings.serviceAccount;
    const tokenUrl =
      this.settings.tokenUrl ?? account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const issuedAt = Math.floor(now / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({
        iss: account.client_email,
        scope: SCOPE,
        aud: tokenUrl,
        iat: issuedAt,
        exp: issuedAt + 3600,
      }),
    )}`;
    let assertion: string;
    try {
      assertion = `${unsigned}.${b64url(createSign('RSA-SHA256').update(unsigned).sign(account.private_key))}`;
    } catch {
      throw new ProviderError('fcm', 'the FCM service-account key could not sign a token', false);
    }
    const { json } = await providerRequest(
      'fcm',
      tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      },
      this.settings.timeoutMs,
    );
    const reply = json as { access_token?: unknown; expires_in?: unknown } | null;
    if (typeof reply?.access_token !== 'string') {
      throw new ProviderError('fcm', 'fcm authentication failed', false);
    }
    const lifetime = typeof reply.expires_in === 'number' ? reply.expires_in : 3600;
    this.accessToken = { value: reply.access_token, expiresAt: now + lifetime * 1000 };
    return reply.access_token;
  }
}
