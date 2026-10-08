import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables, NodeEnv } from './env.validation';

/** Typed accessor over the validated environment. The only place that reads configuration keys by name. */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  private get<K extends keyof EnvironmentVariables>(key: K): EnvironmentVariables[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): NodeEnv {
    return this.get('NODE_ENV');
  }
  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production;
  }
  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }
  get port(): number {
    return this.get('PORT');
  }
  get logLevel(): string {
    return this.get('LOG_LEVEL');
  }
  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }
  get databasePoolMax(): number {
    return this.get('DATABASE_POOL_MAX');
  }
  get databaseQueryTimeoutMs(): number {
    return this.get('DATABASE_QUERY_TIMEOUT_MS');
  }
  get redisUrl(): string {
    return this.get('REDIS_URL');
  }
  get jwtAccessSecret(): string {
    return this.get('JWT_ACCESS_SECRET');
  }
  get jwtAccessTtlSeconds(): number {
    return this.get('JWT_ACCESS_TTL_SECONDS');
  }
  get refreshTokenTtlSeconds(): number {
    return this.get('REFRESH_TOKEN_TTL_SECONDS');
  }
  get throttle(): { ttlMs: number; limit: number } {
    return { ttlMs: this.get('THROTTLE_TTL_SECONDS') * 1000, limit: this.get('THROTTLE_LIMIT') };
  }
  get corsOrigins(): string[] {
    return (this.get('CORS_ORIGINS') ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  get trustProxyHops(): number {
    return this.get('TRUST_PROXY_HOPS');
  }
}
