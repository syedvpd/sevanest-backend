import 'reflect-metadata';
import { parseFcmServiceAccount } from '../integrations/notifications/fcm.provider';
import { plainToInstance, Transform, Type } from 'class-transformer';
import { parseJwtKeys } from './jwt-keys';
import {
  MaxLength,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
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

/** Deployment tier (DEC-12). production and staging apply every production guard; demo OTP flags are allowed only in development and staging. */
export enum AppEnv {
  Production = 'production',
  Staging = 'staging',
  Development = 'development',
}

/** `memory` keeps OTPs in process memory for automated tests and local work. It is refused in production. */
export enum SmsProviderKind {
  Memory = 'memory',
  Disabled = 'disabled',
  /** Twilio Programmable Messaging (free text; for India needs a registered sender / Messaging Service). */
  Twilio = 'twilio',
  /** MSG91 Flow API (India, DLT-registered template). */
  Msg91 = 'msg91',
}

/** Payment gateway adapter. No vendor is selected (Q-08): `fake` is a deterministic test double, refused in production. */
export enum PaymentProviderKind {
  Fake = 'fake',
  Disabled = 'disabled',
  /** Razorpay Orders/Payments/Refunds REST API (test or live keys). */
  Razorpay = 'razorpay',
}

/** Push (FCM) and WhatsApp adapters. Credentials and vendors are open (Q-08); `memory` is for tests and refused in production. */
export enum MessagingProviderKind {
  Memory = 'memory',
  Disabled = 'disabled',
  /** Firebase Cloud Messaging HTTP v1 (push only). */
  Fcm = 'fcm',
}

/** Private object storage for KYC documents. `s3` = any S3-compatible endpoint (Supabase Storage); `memory` is for tests and is refused in production. */
export enum StorageProviderKind {
  S3 = 's3',
  Memory = 'memory',
  Disabled = 'disabled',
}

/** WhatsApp adapter. `twilio` = Twilio WhatsApp (Business sender or sandbox); `memory` is for tests and refused in production. */
export enum WhatsAppProviderKind {
  Memory = 'memory',
  Disabled = 'disabled',
  Twilio = 'twilio',
}

const isSms =
  (...kinds: SmsProviderKind[]) =>
  (o: EnvironmentVariables): boolean =>
    kinds.includes(o.SMS_PROVIDER);
const usesTwilio = (o: EnvironmentVariables): boolean =>
  o.SMS_PROVIDER === SmsProviderKind.Twilio || o.WHATSAPP_PROVIDER === WhatsAppProviderKind.Twilio;
const isRazorpay = (o: EnvironmentVariables): boolean =>
  o.PAYMENT_PROVIDER === PaymentProviderKind.Razorpay;

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

  /** Unset = production when NODE_ENV=production, else development. A staging service sets APP_ENV=staging and keeps the production guards. */
  @IsOptional()
  @IsEnum(AppEnv)
  APP_ENV?: AppEnv;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @IsIn(LOG_LEVELS)
  LOG_LEVEL: (typeof LOG_LEVELS)[number] = 'info';

  /** One structured line per request (route, status, ms, database statements and their time); no bodies, params or tokens. Off by default. */
  @Transform(toBoolean)
  @IsBoolean()
  REQUEST_TIMING_LOG: boolean = false;

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

  /** HS256 shared secret. Required unless JWT_KEYS is set; with JWT_KEYS it only verifies old tokens while JWT_LEGACY_HS256_UNTIL is in the future. */
  @ValidateIf((o: EnvironmentVariables) => !o.JWT_KEYS || o.JWT_ACCESS_SECRET !== undefined)
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET?: string;

  /** DEC-19: ES256 key set, JSON array of {kid, privateKey?, publicKey?}. The first entry signs; later ones only verify (rotation). Unset = legacy HS256. Secret: environment only. */
  @IsOptional()
  @IsString()
  JWT_KEYS?: string;

  /** ISO date until which HS256 tokens are still accepted when JWT_KEYS is set (migration window). Unset = never (the default). */
  @IsOptional()
  @IsISO8601()
  JWT_LEGACY_HS256_UNTIL?: string;

  /** Seconds in which replaying a just-rotated refresh token from the same device answers 409 REFRESH_IN_PROGRESS instead of revoking the session (DEC-14). 0 = off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  REFRESH_REUSE_GRACE_SECONDS: number = 10;

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
   * Where the global per-IP request counters live. `redis` is shared by all API replicas; `memory` is per process, so the
   * real limit is multiplied by the replica count. Use `redis` whenever more than one API instance runs.
   */
  @IsIn(['memory', 'redis'])
  THROTTLE_STORAGE: 'memory' | 'redis' = 'memory';

  /**
   * OTP, lockout and admin-password values below are OPEN business decisions (Q-12, Q-18): the specs say only
   * "configurable". They are therefore REQUIRED with no default, so production cannot start on an unreviewed value.
   */

  /** Key for the HMAC that protects stored OTP verifiers. Separate from the JWT secret so either can rotate alone. */
  @IsString()
  @MinLength(32)
  OTP_HMAC_SECRET!: string;

  /** OTP delivery channel: `twilio` or `msg91` for real delivery; `memory`/`disabled` are never a real channel. */
  @IsEnum(SmsProviderKind)
  SMS_PROVIDER!: SmsProviderKind;

  /** Timeout for every outbound SMS/WhatsApp/payment-gateway call. Engineering knob, not a business rule. */
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(60000)
  PROVIDER_HTTP_TIMEOUT_MS: number = 8000;

  /**
   * Optional malware scanning of uploaded KYC documents with a ClamAV daemon (clamd) that the operator runs. Unset = documents are
   * validated (type, size, content) but not scanned, and the readiness report says so.
   */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  CLAMAV_HOST?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  CLAMAV_PORT: number = 3310;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(120000)
  CLAMAV_TIMEOUT_MS: number = 20000;

  // --- Twilio (SMS and/or WhatsApp). Credentials live only in the environment / deployment secret store. ---
  @ValidateIf(usesTwilio)
  @IsString()
  @Matches(/^AC[0-9a-fA-F]{32}$/, {
    message: 'TWILIO_ACCOUNT_SID must look like AC + 32 hex characters',
  })
  TWILIO_ACCOUNT_SID?: string;

  @ValidateIf(usesTwilio)
  @IsString()
  @MinLength(16)
  TWILIO_AUTH_TOKEN?: string;

  /** Preferred SMS sender (MG + 32 hex). Either this or TWILIO_SMS_FROM is required when SMS_PROVIDER=twilio. */
  @IsOptional()
  @Matches(/^MG[0-9a-fA-F]{32}$/, {
    message: 'TWILIO_MESSAGING_SERVICE_SID must look like MG + 32 hex characters',
  })
  TWILIO_MESSAGING_SERVICE_SID?: string;

  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/, {
    message: 'TWILIO_SMS_FROM must be an E.164 number such as +14155550100',
  })
  TWILIO_SMS_FROM?: string;

  @ValidateIf((o: EnvironmentVariables) => o.WHATSAPP_PROVIDER === WhatsAppProviderKind.Twilio)
  @IsString()
  @Matches(/^(whatsapp:)?\+[1-9]\d{6,14}$/, {
    message: 'TWILIO_WHATSAPP_FROM must be an E.164 number, optionally prefixed with whatsapp:',
  })
  TWILIO_WHATSAPP_FROM?: string;

  // --- MSG91 (India, DLT) ---
  @ValidateIf(isSms(SmsProviderKind.Msg91))
  @IsString()
  @MinLength(10)
  MSG91_AUTH_KEY?: string;

  /** Flow template id of the DLT-approved OTP template. */
  @ValidateIf(isSms(SmsProviderKind.Msg91))
  @IsString()
  @MinLength(8)
  MSG91_OTP_TEMPLATE_ID?: string;

  /** Variable name used for the OTP inside that template (##OTP## -> OTP). */
  @IsString()
  @Matches(/^[A-Za-z0-9_]{1,30}$/)
  MSG91_OTP_VARIABLE: string = 'OTP';

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

  /**
   * Profile photo size limit in bytes (FRD FM-04: "size limit applies"). On by default at 5 MB (DEC-10, owner sign-off pending); types are
   * fixed to JPEG and PNG (signature-checked).
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  PROFILE_PHOTO_MAX_BYTES: number = 5_242_880;

  /** A worker cannot submit the profile for verification without a confirmed photo (FM-04, DEC-10). Set false only to run without the rule. */
  @Transform(toBoolean)
  @IsBoolean()
  PROFILE_PHOTO_REQUIRED: boolean = true;

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

  // --- Razorpay (test keys rzp_test_*, live keys rzp_live_*). Secrets never leave the environment. ---
  @ValidateIf(isRazorpay)
  @IsString()
  @Matches(/^rzp_(test|live)_[A-Za-z0-9]{8,}$/, {
    message: 'RAZORPAY_KEY_ID must look like rzp_test_xxx or rzp_live_xxx',
  })
  RAZORPAY_KEY_ID?: string;

  @ValidateIf(isRazorpay)
  @IsString()
  @MinLength(16)
  RAZORPAY_KEY_SECRET?: string;

  /** The secret typed when creating the webhook in the Razorpay dashboard (NOT the API key secret). */
  @ValidateIf((o: EnvironmentVariables) => isRazorpay(o) && o.RAZORPAY_WEBHOOK_SECRET !== undefined)
  @IsString()
  @MinLength(8)
  RAZORPAY_WEBHOOK_SECRET?: string;

  /** HMAC key the FAKE payment adapter uses to sign test webhooks. Required (and only used) when PAYMENT_PROVIDER=fake. */
  @ValidateIf((o: EnvironmentVariables) => o.PAYMENT_PROVIDER === PaymentProviderKind.Fake)
  @IsString()
  @MinLength(16)
  PAYMENT_FAKE_WEBHOOK_SECRET?: string;

  @IsEnum(MessagingProviderKind)
  PUSH_PROVIDER!: MessagingProviderKind;

  @IsEnum(WhatsAppProviderKind)
  WHATSAPP_PROVIDER!: WhatsAppProviderKind;

  /** Top of the rating scale (FRD FM-10: "within the configured scale"). The scale is an OPEN decision (Q-58): required, no default. Lowest score is 1. */
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10)
  RATING_SCALE_MAX!: number;

  /** Longest review a customer may write (FRD FM-10 asks for a limit without a value; the app design says 300). Business value, D-80. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2000)
  RATING_REVIEW_MAX_LENGTH?: number;

  /** true = a REPLACED booking ("ended early") may be rated like a COMPLETED one. Off until the client decides (Q-102). */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  RATING_ALLOW_ENDED_EARLY?: boolean;

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

  /** Run the background loops inside the API process (see app.module.ts). Default false: use the separate worker process. */
  @Transform(toBoolean)
  @IsBoolean()
  EMBEDDED_WORKERS: boolean = false;

  /** Hours a matched worker has to accept/decline before staff are alerted (DEC-02). Default 4; 0 = off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  WORKER_RESPONSE_HOURS: number = 4;

  /**
   * DEC-08 retention and erasure. OFF by default (needs legal sign-off). When enabled the worker removes data past its retention period
   * and anonymises accounts whose deletion request is older than DELETION_COOLING_OFF_DAYS. Audit logs, payments and receipts are never
   * touched. With RETENTION_DRY_RUN=true (the default) a run only counts what it would remove.
   */
  @Transform(toBoolean)
  @IsBoolean()
  RETENTION_ENABLED: boolean = false;

  @Transform(toBoolean)
  @IsBoolean()
  RETENTION_DRY_RUN: boolean = true;

  /** In-app/push/SMS notification rows older than this many months are removed (DEC-08: 12). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(240)
  RETENTION_NOTIFICATIONS_MONTHS: number = 12;

  /** Processed outbox events (with no notification row left) older than this many days are removed (DEC-08: 90). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  RETENTION_OUTBOX_DAYS: number = 90;

  /** Stored files of rejected KYC checks are deleted after this many days (DEC-08: 90). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  RETENTION_KYC_REJECTED_DAYS: number = 90;

  /** Days between an account deletion request and the anonymisation (DEC-08: 30); the user can withdraw until then. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  DELETION_COOLING_OFF_DAYS: number = 30;

  /** Rows handled per task per run. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  RETENTION_BATCH_SIZE: number = 500;

  /** Minutes between retention runs in the worker. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1440)
  RETENTION_INTERVAL_MINUTES: number = 60;

  /** DEC-16: admin edits of existing records must carry If-Match (428 without it, 412 when stale). false = header optional, as before. */
  @Transform(toBoolean)
  @IsBoolean()
  ADMIN_IF_MATCH_REQUIRED: boolean = true;

  /** Refund a paid booking automatically when it is cancelled before it is ACTIVE (DEC-04). After ACTIVE staff decide. */
  @Transform(toBoolean)
  @IsBoolean()
  AUTO_REFUND_ON_CANCEL: boolean = true;

  /** Hours after which a matched worker who has not answered loses the booking back to matching (DEC-02). Default 24; 0 = off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  WORKER_REASSIGN_HOURS: number = 24;

  /** Hours a booking may wait in PENDING_PAYMENT before staff are alerted (DEC-01). Default 1; 0 = off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  PENDING_PAYMENT_ALERT_HOURS: number = 1;

  /** Hours after which an unpaid PENDING_PAYMENT booking is cancelled automatically (DEC-01). Default 12; 0 = off. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  PENDING_PAYMENT_AUTO_CANCEL_HOURS: number = 12;

  /**
   * How many days before the agreed start date a customer or worker may press "start". Default 0 = not before the start date (staff may always
   * start). The business has not set a tolerance (interim default); raise it here without a code change.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  BOOKING_START_EARLY_DAYS?: number;

  /** Minutes a worker needs between two jobs on the same day (travel). 0 = back-to-back bookings allowed. Business value, not decided (Q-84). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(240)
  BOOKING_TRAVEL_BUFFER_MINUTES: number = 0;

  /**
   * Seconds a customer worker-search page may be served from an in-process cache shared by customers without blocks. 0 = off (the
   * default: every search reads the database). A small value (10-30) trades a little freshness of the list for a large cut in database
   * work; booking confirmation always re-checks eligibility and busy hours, so a stale card can never produce a wrong booking.
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(300)
  SEARCH_CACHE_TTL_SECONDS: number = 0;

  /**
   * Automatically mark a customer VERIFIED once they have a complete profile and an active address (and PENDING again without one). Staff
   * decisions are never overridden. Interim rule until the business defines customer verification; false = staff only.
   */
  @Transform(toBoolean)
  @IsBoolean()
  CUSTOMER_AUTO_VERIFY: boolean = true;

  /** Resolution target in hours for a ticket without a priority (DEC-03). Default 48; 0 = no target. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  SUPPORT_SLA_HOURS_DEFAULT: number = 48;

  /** Resolution target in hours for LOW priority tickets (DEC-03). Default 72; 0 = no target. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  SUPPORT_SLA_HOURS_LOW: number = 72;

  /** Resolution target in hours for MEDIUM priority tickets (DEC-03). Default 48; 0 = no target. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  SUPPORT_SLA_HOURS_MEDIUM: number = 48;

  /** Resolution target in hours for HIGH priority tickets (DEC-03). Default 24; 0 = no target. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  SUPPORT_SLA_HOURS_HIGH: number = 24;

  /** Current legal document versions. Unset = no consent is requested or enforced (legal review pending, PRD 13). */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,40}$/)
  LEGAL_TERMS_VERSION?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{1,40}$/)
  LEGAL_PRIVACY_VERSION?: string;

  @IsOptional()
  @IsString()
  LEGAL_TERMS_URL?: string;

  @IsOptional()
  @IsString()
  LEGAL_PRIVACY_URL?: string;

  /** When true, creating a booking requires the user to have accepted the CURRENT terms and privacy versions. */
  @Transform(toBoolean)
  @IsBoolean()
  LEGAL_ACCEPTANCE_REQUIRED: boolean = false;

  /** App update policy returned by GET /app-config (semver). Unset = no minimum. */
  @IsOptional()
  @Matches(/^\d+\.\d+\.\d+$/)
  APP_MIN_VERSION_CUSTOMER?: string;

  @IsOptional()
  @Matches(/^\d+\.\d+\.\d+$/)
  APP_MIN_VERSION_WORKER?: string;

  /** Store page the "Update required" button opens (https). Unset = the app hides the button. */
  @IsOptional()
  @Matches(/^https:\/\/\S+$/, { message: 'APP_STORE_URL_CUSTOMER must be an https URL' })
  APP_STORE_URL_CUSTOMER?: string;

  @IsOptional()
  @Matches(/^https:\/\/\S+$/, { message: 'APP_STORE_URL_WORKER must be an https URL' })
  APP_STORE_URL_WORKER?: string;

  @Transform(toBoolean)
  @IsBoolean()
  APP_MAINTENANCE_MODE: boolean = false;

  @IsOptional()
  @IsString()
  SUPPORT_CONTACT_PHONE?: string;

  @IsOptional()
  @IsString()
  SUPPORT_CONTACT_EMAIL?: string;

  /** Approved cancellation / refund policy shown by the apps (GET /app-config policy). Unset = not published. Text is supplied by the client. */
  @IsOptional()
  @MaxLength(4000)
  POLICY_CANCELLATION_TEXT?: string;

  @IsOptional()
  @MaxLength(4000)
  POLICY_REFUND_TEXT?: string;

  @IsOptional()
  @Matches(/^https:\/\/\S+$/, { message: 'POLICY_CANCELLATION_URL must be an https URL' })
  POLICY_CANCELLATION_URL?: string;

  @IsOptional()
  @Matches(/^https:\/\/\S+$/, { message: 'POLICY_REFUND_URL must be an https URL' })
  POLICY_REFUND_URL?: string;

  /** Firebase service-account JSON (one line) for PUSH_PROVIDER=fcm. Secret: environment only. */
  @ValidateIf((o: EnvironmentVariables) => o.PUSH_PROVIDER === MessagingProviderKind.Fcm)
  @IsString()
  @MinLength(50)
  FCM_SERVICE_ACCOUNT_JSON?: string;

  /**
   * STAGING/DEMO ONLY, refused when NODE_ENV=production (D-70). When true, the mobile numbers in TEST_OTP_NUMBERS log in with the fixed TEST_OTP_CODE and no SMS is sent
   * (so the apps can be tested before an SMS provider exists). Every other number behaves exactly as without it. Everything else
   * about the OTP (cooldown, attempt limit, lockout, expiry, single use) is unchanged. Never enable it for real users.
   */
  @Transform(toBoolean)
  @IsBoolean()
  ALLOW_TEST_OTP: boolean = false;

  /** Comma-separated E.164 numbers, e.g. +919999900001,+919999900002. Required when ALLOW_TEST_OTP=true. */
  @ValidateIf((o: EnvironmentVariables) => o.ALLOW_TEST_OTP)
  @IsString()
  @Matches(/^\+[1-9]\d{9,14}(,\s*\+[1-9]\d{9,14})*$/, {
    message:
      'TEST_OTP_NUMBERS must be a comma-separated list of E.164 numbers such as +919999900001',
  })
  TEST_OTP_NUMBERS?: string;

  /** The fixed code (exactly OTP_LENGTH digits). Required when ALLOW_TEST_OTP=true; there is deliberately no default. */
  @ValidateIf((o: EnvironmentVariables) => o.ALLOW_TEST_OTP)
  @IsString()
  @Matches(/^\d{4,10}$/, { message: 'TEST_OTP_CODE must be 4 to 10 digits' })
  TEST_OTP_CODE?: string;

  /**
   * STAGING/DEMO ONLY, refused when NODE_ENV=production. When true, OTP request never sends an SMS (so it never answers 503) and OTP
   * verify accepts ANY code for ANY valid mobile number: the apps show their own demo OTP and the backend still issues a real session.
   * Anyone who knows a number can log in as it. Use until an SMS provider exists, then turn it off.
   */
  @Transform(toBoolean)
  @IsBoolean()
  DEMO_OTP_ACCEPT_ANY: boolean = false;

  /** Comma-separated E.164 numbers allowed to use DEMO_OTP_ACCEPT_ANY. Required when it is on: no other number is ever accepted without a real code. */
  @ValidateIf((o: EnvironmentVariables) => o.DEMO_OTP_ACCEPT_ANY)
  @IsString()
  @Matches(/^\+[1-9]\d{9,14}(,\s*\+[1-9]\d{9,14})*$/, {
    message:
      'DEMO_OTP_NUMBERS must be a comma-separated list of E.164 numbers such as +919999900001',
  })
  DEMO_OTP_NUMBERS?: string;

  /** Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client IPs behind a load balancer. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;
}

export function validateEnvironment(raw: Record<string, unknown>): EnvironmentVariables {
  // A platform that passes blank variables (e.g. an unset dashboard field) means "not set", not an empty value.
  const config = plainToInstance(
    EnvironmentVariables,
    Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== '')),
  );
  const errors = validateSync(config, { skipMissingProperties: false });
  if (errors.length > 0) {
    const problems = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  if (
    config.SMS_PROVIDER === SmsProviderKind.Twilio &&
    !config.TWILIO_MESSAGING_SERVICE_SID &&
    !config.TWILIO_SMS_FROM
  ) {
    throw new Error(
      'Invalid environment configuration: SMS_PROVIDER=twilio needs TWILIO_MESSAGING_SERVICE_SID or TWILIO_SMS_FROM',
    );
  }
  if (config.PUSH_PROVIDER === MessagingProviderKind.Fcm) {
    try {
      parseFcmServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON ?? '');
    } catch (error) {
      throw new Error(`Invalid environment configuration: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  const appEnv =
    config.APP_ENV ??
    (config.NODE_ENV === NodeEnv.Production ? AppEnv.Production : AppEnv.Development);
  const isProductionTier = config.NODE_ENV === NodeEnv.Production || appEnv === AppEnv.Production;
  const isStrictTier = isProductionTier || appEnv === AppEnv.Staging;
  if (config.DEMO_OTP_ACCEPT_ANY) {
    if (isProductionTier) {
      throw new Error(
        'Invalid environment configuration: DEMO_OTP_ACCEPT_ANY=true is not allowed in production (NODE_ENV=production or APP_ENV=production)',
      );
    }
    process.emitWarning(
      'DEMO_OTP_ACCEPT_ANY=true: ANY code logs in ANY mobile number and no SMS is sent. Staging/demo only - turn it off for real users',
      'ConfigWarning',
    );
  }
  if (config.ALLOW_TEST_OTP) {
    // D-70: a fixed login code must never reach real users, so production refuses to start with it (fail closed).
    if (isProductionTier) {
      throw new Error(
        'Invalid environment configuration: ALLOW_TEST_OTP=true is not allowed in production (NODE_ENV=production or APP_ENV=production)',
      );
    }
    if (config.TEST_OTP_CODE!.length !== config.OTP_LENGTH) {
      throw new Error(
        'Invalid environment configuration: TEST_OTP_CODE must have exactly OTP_LENGTH digits',
      );
    }
    process.emitWarning(
      'ALLOW_TEST_OTP=true: the numbers in TEST_OTP_NUMBERS log in with a FIXED code and no SMS. Staging/demo only - turn it off for real users',
      'ConfigWarning',
    );
  }
  if (
    config.PENDING_PAYMENT_ALERT_HOURS > 0 &&
    config.PENDING_PAYMENT_AUTO_CANCEL_HOURS > 0 &&
    config.PENDING_PAYMENT_AUTO_CANCEL_HOURS <= config.PENDING_PAYMENT_ALERT_HOURS
  ) {
    throw new Error(
      'Invalid environment configuration: PENDING_PAYMENT_AUTO_CANCEL_HOURS must be greater than PENDING_PAYMENT_ALERT_HOURS',
    );
  }
  if (isRazorpay(config) && !config.RAZORPAY_WEBHOOK_SECRET) {
    // Allowed (development): payments still complete through the client verification and the recovery sweeper, but gateway
    // notifications are refused. Production should set it so a lost client report is caught in real time.
    process.emitWarning(
      'RAZORPAY_WEBHOOK_SECRET is not set: Razorpay webhooks are rejected; payments rely on client verification and the periodic recovery check',
      'ConfigWarning',
    );
  }
  // Payments silently answering 503 because the gateway was configured under the wrong name is easy to miss on a dashboard.
  if (
    typeof raw.PAYMENT_GATEWAY === 'string' &&
    raw.PAYMENT_GATEWAY !== String(config.PAYMENT_PROVIDER)
  ) {
    process.emitWarning(
      `PAYMENT_GATEWAY is not read: the gateway is chosen by PAYMENT_PROVIDER (now ${config.PAYMENT_PROVIDER}). Set PAYMENT_PROVIDER=${raw.PAYMENT_GATEWAY}`,
      'ConfigWarning',
    );
  }
  if (!isRazorpay(config) && (raw.RAZORPAY_KEY_ID || raw.RAZORPAY_KEY_SECRET)) {
    process.emitWarning(
      `Razorpay keys are set but PAYMENT_PROVIDER=${config.PAYMENT_PROVIDER}: they are ignored. Set PAYMENT_PROVIDER=razorpay to use them`,
      'ConfigWarning',
    );
  }
  if (config.JWT_KEYS) {
    try {
      parseJwtKeys(config.JWT_KEYS);
    } catch (error) {
      throw new Error(`Invalid environment configuration: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  if (config.JWT_LEGACY_HS256_UNTIL && !config.JWT_ACCESS_SECRET) {
    throw new Error(
      'Invalid environment configuration: JWT_LEGACY_HS256_UNTIL needs JWT_ACCESS_SECRET (the secret old tokens were signed with)',
    );
  }
  if (isStrictTier) {
    if (!config.JWT_KEYS) {
      process.emitWarning(
        'JWT_KEYS is not set: access tokens use the HS256 shared secret (no key rotation). Set an ES256 key set (see docs/JWT_ROTATION.md)',
        'ConfigWarning',
      );
    }
    if (config.JWT_ACCESS_SECRET && /change-me|example|secret/i.test(config.JWT_ACCESS_SECRET)) {
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
      config.WHATSAPP_PROVIDER === WhatsAppProviderKind.Memory
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
    if (
      raw.TRUST_PROXY_HOPS === undefined ||
      (typeof raw.TRUST_PROXY_HOPS === 'string' && raw.TRUST_PROXY_HOPS.trim() === '')
    ) {
      // Deliberately no default in production: 0 behind a load balancer collapses every per-IP limit (OTP, admin login, request
      // throttle) onto the balancer's address; too high lets clients forge X-Forwarded-For. Only the operator knows the topology.
      throw new Error(
        'Invalid environment configuration: TRUST_PROXY_HOPS must be set explicitly in production ' +
          '(number of trusted reverse-proxy hops in front of the API; 0 only if clients reach the API directly; see README)',
      );
    }
    if (config.SMS_PROVIDER === SmsProviderKind.Disabled) {
      process.emitWarning(
        'SMS_PROVIDER=disabled in production: nobody can log in with an OTP until a real SMS provider is configured',
        'ConfigWarning',
      );
    }
    if (config.PAYMENT_PROVIDER === PaymentProviderKind.Disabled) {
      process.emitWarning(
        'PAYMENT_PROVIDER=disabled in production: no booking can be paid',
        'ConfigWarning',
      );
    }
    if (config.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
      process.emitWarning(
        'RAZORPAY_KEY_ID is a TEST key in production: no real money moves',
        'ConfigWarning',
      );
    }
    if (raw.THROTTLE_STORAGE === undefined || raw.THROTTLE_STORAGE === '') {
      // Production default is the shared store: a missing setting must not silently weaken the per-IP limit across replicas.
      config.THROTTLE_STORAGE = 'redis';
    }
    if (config.THROTTLE_STORAGE === 'memory') {
      process.emitWarning(
        'THROTTLE_STORAGE=memory in production: the request limit is per process; use redis with more than one API instance',
        'ConfigWarning',
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
