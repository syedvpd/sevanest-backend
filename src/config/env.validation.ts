import 'reflect-metadata';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

/**
 * Typed, validated environment. Values the specs leave open (token lifetimes, throttle limits) are REQUIRED here
 * on purpose: nothing is silently defaulted into production. Only engineering knobs carry defaults.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  /** Interactive OpenAPI docs. Off unless explicitly enabled. */
  @Transform(toBoolean)
  @IsBoolean()
  SWAGGER_ENABLED: boolean = false;

  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
  })
  DATABASE_URL!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  DATABASE_POOL_MAX: number = 10;

  @Type(() => Number)
  @IsInt()
  @Min(100)
  DATABASE_QUERY_TIMEOUT_MS: number = 10000;

  @IsString()
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must be a redis:// or rediss:// URL' })
  REDIS_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  JWT_ACCESS_TTL_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  REFRESH_TOKEN_TTL_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_TTL_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT!: number;

  /** Comma-separated browser origins allowed by CORS. Empty/unset disables CORS (mobile apps do not need it). */
  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  /** Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs behind a load balancer. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;
}

export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw);
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const problems = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  if (config.NODE_ENV === NodeEnv.Production) {
    if (/change-me|example|secret/i.test(config.JWT_ACCESS_SECRET)) {
      throw new Error(
        'Invalid environment configuration: JWT_ACCESS_SECRET looks like a placeholder',
      );
    }
    if (config.SWAGGER_ENABLED) {
      // Not forbidden, but never an accident: it must be a deliberate, reviewed choice.
      process.emitWarning(
        'SWAGGER_ENABLED=true in production exposes the API surface',
        'ConfigWarning',
      );
    }
  }
  return config;
}
