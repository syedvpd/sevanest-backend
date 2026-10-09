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
  ValidateIf,
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

/** `memory` keeps OTPs in process memory for automated tests and local work. It is refused in production. */
export enum SmsProviderKind {
  Memory = 'memory',
  Disabled = 'disabled',
}

/** Payment gateway adapter. No vendor is selected (Q-08): `fake` is a deterministic test double, refused in production. */
export enum PaymentProviderKind {
  Fake = 'fake',
  Disabled = 'disabled',
}

/** Push (FCM) and WhatsApp adapters. Credentials and vendors are open (Q-08); `memory` is for tests and refused in production. */
export enum MessagingProviderKind {
  Memory = 'memory',
  Disabled = 'disabled',
}

/** Private object storage for KYC documents. `s3` = any S3-compatible endpoint (Supabase Storage); `memory` is for tests and is refused in production. */
export enum StorageProviderKind {
  S3 = 's3',
  Memory = 'memory',
  Disabled = 'disabled',
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

  /**
   * OTP, lockout and admin-password values below are OPEN business decisions (Q-12, Q-18): the specs say only
   * "configurable". They are therefore REQUIRED with no default, so production cannot start on an unreviewed value.
   */

  /** Key for the HMAC that protects stored OTP verifiers. Separate from the JWT secret so either can rotate alone. */
  @IsString()
  @MinLength(32)
  OTP_HMAC_SECRET!: string;

  /** OTP delivery channel. No SMS vendor is selected yet (SRS §14), so only these two adapters exist. */
  @IsEnum(SmsProviderKind)
  SMS_PROVIDER!: SmsProviderKind;

  /**
   * KYC document handling. File size, accepted types and link lifetime are OPEN decisions (Q-12), so they are REQUIRED with
   * no default. Accepted types must be a subset of the types the platform can sniff: application/pdf, image/jpeg, image/png.
   */
  @IsEnum(StorageProviderKind)
  STORAGE_PROVIDER!: StorageProviderKind;

  /** S3-compatible object storage (Supabase Storage). Required only when STORAGE_PROVIDER=s3; the bucket must be private. */
  @ValidateIf((o: EnvironmentVariables) => o.STORAGE_PROVIDER === StorageProviderKind.S3)
  @IsString()
  @Matches(/^https?:\/\//, { message: 'STORAGE_S3_ENDPOINT must be an http(s) URL' })
  STORAGE_S3_ENDPOINT?: string;

  @ValidateIf((o: EnvironmentVariables) => o.STORAGE_PROVIDER === StorageProviderKind.S3)
  @IsString()
  @MinLength(1)
  STORAGE_S3_REGION?: string;

  @ValidateIf((o: EnvironmentVariables) => o.STORAGE_PROVIDER === StorageProviderKind.S3)
  @IsString()
  @MinLength(1)
  STORAGE_S3_BUCKET?: string;

  @ValidateIf((o: EnvironmentVariables) => o.STORAGE_PROVIDER === StorageProviderKind.S3)
  @IsString()
  @MinLength(1)
  STORAGE_S3_ACCESS_KEY_ID?: string;

  @ValidateIf((o: EnvironmentVariables) => o.STORAGE_PROVIDER === StorageProviderKind.S3)
  @IsString()
  @MinLength(1)
  STORAGE_S3_SECRET_ACCESS_KEY?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  VERIFICATION_DOCUMENT_MAX_BYTES!: number;

  @IsString()
  @Matches(
    /^(application\/pdf|image\/jpeg|image\/png)(,(application\/pdf|image\/jpeg|image\/png))*$/,
    {
      message:
        'VERIFICATION_DOCUMENT_CONTENT_TYPES must be a comma-separated subset of application/pdf, image/jpeg, image/png',
    },
  )
  VERIFICATION_DOCUMENT_CONTENT_TYPES!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  SIGNED_URL_TTL_SECONDS!: number;

  /** Payments and notification channels. Vendors are not selected (Q-08), so only `disabled` and test doubles exist. */
  @IsEnum(PaymentProviderKind)
  PAYMENT_PROVIDER!: PaymentProviderKind;

  /** HMAC key the FAKE payment adapter uses to sign test webhooks. Required (and only used) when PAYMENT_PROVIDER=fake. */
  @ValidateIf((o: EnvironmentVariables) => o.PAYMENT_PROVIDER === PaymentProviderKind.Fake)
  @IsString()
  @MinLength(16)
  PAYMENT_FAKE_WEBHOOK_SECRET?: string;

  @IsEnum(MessagingProviderKind)
  PUSH_PROVIDER!: MessagingProviderKind;

  @IsEnum(MessagingProviderKind)
  WHATSAPP_PROVIDER!: MessagingProviderKind;

  /** Top of the rating scale (FRD FM-10: "within the configured scale"). The scale is an OPEN decision (Q-58): required, no default. Lowest score is 1. */
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10)
  RATING_SCALE_MAX!: number;

  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(10)
  OTP_LENGTH!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_TTL_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_MAX_VERIFY_ATTEMPTS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_RESEND_COOLDOWN_SECONDS!: number;

  /** Window over which the per-mobile and per-IP send counters are evaluated. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_SEND_WINDOW_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_MAX_REQUESTS_PER_IP_PER_WINDOW!: number;

  /** Temporary block once the verify-attempt limit is exceeded (FRD FM-01: "temporary block with message"). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  OTP_LOCKOUT_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  ADMIN_LOGIN_MAX_FAILURES!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  ADMIN_LOGIN_FAILURE_WINDOW_SECONDS!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  ADMIN_LOGIN_LOCKOUT_SECONDS!: number;

  /** Minimum length for admin passwords. The policy itself is undefined (FR-AUTH-006), so the number is configuration. */
  @Type(() => Number)
  @IsInt()
  @Min(8)
  ADMIN_PASSWORD_MIN_LENGTH!: number;

  /**
   * Optional allow-list of language codes for customer profiles. The specs say "supported languages" without listing
   * them, so when unset any well-formed language code is accepted.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*(,\s*[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)*$/, {
    message: 'SUPPORTED_LANGUAGES must be a comma-separated list of language codes such as "en,hi"',
  })
  SUPPORTED_LANGUAGES?: string;

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
    if (/change-me|example|secret|do-not-use/i.test(config.OTP_HMAC_SECRET)) {
      throw new Error(
        'Invalid environment configuration: OTP_HMAC_SECRET looks like a placeholder',
      );
    }
    if (config.PAYMENT_PROVIDER === PaymentProviderKind.Fake) {
      throw new Error(
        'Invalid environment configuration: PAYMENT_PROVIDER=fake is not allowed in production',
      );
    }
    if (
      config.PUSH_PROVIDER === MessagingProviderKind.Memory ||
      config.WHATSAPP_PROVIDER === MessagingProviderKind.Memory
    ) {
      throw new Error(
        'Invalid environment configuration: PUSH_PROVIDER/WHATSAPP_PROVIDER=memory is not allowed in production',
      );
    }
    if (config.STORAGE_PROVIDER === StorageProviderKind.Memory) {
      throw new Error(
        'Invalid environment configuration: STORAGE_PROVIDER=memory is not allowed in production',
      );
    }
    if (config.SMS_PROVIDER === SmsProviderKind.Memory) {
      throw new Error(
        'Invalid environment configuration: SMS_PROVIDER=memory is not allowed in production',
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
