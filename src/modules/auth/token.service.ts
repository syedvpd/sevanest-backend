import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import type { JwtKeySet } from '../../config/jwt-keys';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';

export const TOKEN_ISSUER = 'sevanest-api';
export const TOKEN_AUDIENCE = 'sevanest-clients';

/** What TokenService needs from configuration (AppConfigService satisfies it). */
export interface TokenKeyConfig {
  readonly jwtAccessSecret: string | undefined;
  readonly jwtKeySet: JwtKeySet | null;
  readonly jwtLegacyHs256Accepted: boolean;
}

/** Access-token claims. Deliberately minimal: roles/permissions are resolved from the database on every request. */
export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Server-side session id; the token is only valid while that session is active. */
  sid: string;
}

const REFRESH_TOKEN_BYTES = 48;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(AppConfigService) private readonly keys: TokenKeyConfig,
  ) {}

  /** ES256 with a kid when JWT_KEYS is configured (DEC-19), else the legacy HS256 shared secret. */
  signAccessToken(claims: AccessTokenClaims): Promise<string> {
    const payload = { sub: claims.sub, sid: claims.sid };
    const set = this.keys.jwtKeySet;
    if (set) {
      return this.jwt.signAsync(payload, {
        algorithm: 'ES256',
        keyid: set.signing.kid,
        secret: set.signing.privateKey,
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
    }
    return this.jwt.signAsync(payload, {
      algorithm: 'HS256',
      secret: this.keys.jwtAccessSecret,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
  }

  /**
   * Picks the verification key from the token header, but never lets the header choose the algorithm family: ES256 is checked only
   * against the configured public keys (by kid), HS256 only against the legacy secret and only while it is accepted. Anything else
   * (alg=none, an HS256 token "signed" with a public key, an unknown kid) is refused.
   */
  private async verifyWithKey(token: string): Promise<Partial<AccessTokenClaims>> {
    const header = this.jwt.decode<{ header?: { alg?: string; kid?: string } } | null>(token, {
      complete: true,
    })?.header;
    const common = { issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE };
    const set = this.keys.jwtKeySet;
    if (header?.alg === 'ES256' && set) {
      const publicKey = header.kid ? set.verify.get(header.kid) : undefined;
      if (!publicKey) throw new Error('unknown kid');
      return this.jwt.verifyAsync<Partial<AccessTokenClaims>>(token, {
        ...common,
        algorithms: ['ES256'],
        secret: publicKey,
      });
    }
    if (header?.alg === 'HS256' && this.keys.jwtLegacyHs256Accepted && this.keys.jwtAccessSecret) {
      return this.jwt.verifyAsync<Partial<AccessTokenClaims>>(token, {
        ...common,
        algorithms: ['HS256'],
        secret: this.keys.jwtAccessSecret,
      });
    }
    throw new Error('unsupported algorithm');
  }

  /** Throws a 401 DomainException for any invalid, expired, tampered or wrongly-signed token. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.verifyWithKey(token);
      if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new Error('missing claims');
      }
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      throw new DomainException(
        ErrorCode.UNAUTHENTICATED,
        'Invalid or expired access token',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  /** Opaque, high-entropy refresh token. Only its hash is ever stored (BEA p5). */
  generateRefreshToken(): string {
    return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  /** SHA-256 is appropriate here because the input is 384 bits of randomness, not a human-chosen secret. */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
