import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';

export const TOKEN_ISSUER = 'sevanest-api';
export const TOKEN_AUDIENCE = 'sevanest-clients';
const JWT_ALGORITHM = 'HS256';

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
  constructor(private readonly jwt: JwtService) {}

  signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(
      { sub: claims.sub, sid: claims.sid },
      { algorithm: JWT_ALGORITHM, issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE },
    );
  }

  /** Throws a 401 DomainException for any invalid, expired, tampered or wrongly-signed token. */
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.jwt.verifyAsync<Partial<AccessTokenClaims>>(token, {
        algorithms: [JWT_ALGORITHM],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
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
