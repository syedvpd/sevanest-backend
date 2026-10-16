import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseJwtKeys, type JwtKeySet } from './jwt-keys';
import {
  EnvironmentVariables,
  MessagingProviderKind,
  WhatsAppProviderKind,
  AppEnv,
  NodeEnv,
  PaymentProviderKind,
  SmsProviderKind,
  StorageProviderKind,
} from './env.validation';

export interface OtpSettings {
  length: number;
  ttlSeconds: number;
  maxVerifyAttempts: number;
  resendCooldownSeconds: number;
  sendWindowSeconds: number;
  maxSendsPerMobilePerWindow: number;
  maxRequestsPerIpPerWindow: number;
  lockoutSeconds: number;
}

export interface AdminLoginSettings {
  maxFailures: number;
  failureWindowSeconds: number;
  lockoutSeconds: number;
  passwordMinLength: number;
}

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
  /** DEC-12 tier: APP_ENV, or production when NODE_ENV=production, else development. */
  get appEnv(): AppEnv {
    return (
      this.get('APP_ENV') ??
      (this.nodeEnv === NodeEnv.Production ? AppEnv.Production : AppEnv.Development)
    );
  }
  get isProduction(): boolean {
    return this.nodeEnv === NodeEnv.Production || this.appEnv === AppEnv.Production;
  }
  get isTest(): boolean {
    return this.nodeEnv === NodeEnv.Test;
  }
  get port(): number {
    return this.get('PORT');
  }
  get requestTimingLog(): boolean {
    return this.get('REQUEST_TIMING_LOG');
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
  get jwtAccessSecret(): string | undefined {
    return this.get('JWT_ACCESS_SECRET');
  }
  private jwtKeySetCache: JwtKeySet | null | undefined;
  /** The ES256 key set, or null while the service still runs on the legacy HS256 secret. */
  get jwtKeySet(): JwtKeySet | null {
    if (this.jwtKeySetCache === undefined) {
      const raw = this.get('JWT_KEYS');
      this.jwtKeySetCache = raw ? parseJwtKeys(raw) : null;
    }
    return this.jwtKeySetCache;
  }
  /** HS256 tokens are accepted: always without JWT_KEYS, otherwise only until JWT_LEGACY_HS256_UNTIL. */
  get jwtLegacyHs256Accepted(): boolean {
    if (!this.get('JWT_KEYS')) return true;
    const until = this.get('JWT_LEGACY_HS256_UNTIL');
    return !!until && !!this.get('JWT_ACCESS_SECRET') && Date.now() < Date.parse(until);
  }
  get refreshReuseGraceSeconds(): number {
    return this.get('REFRESH_REUSE_GRACE_SECONDS');
  }
  get jwtAccessTtlSeconds(): number {
    return this.get('JWT_ACCESS_TTL_SECONDS');
  }
  get refreshTokenTtlSeconds(): number {
    return this.get('REFRESH_TOKEN_TTL_SECONDS');
  }
  get throttle(): { ttlMs: number; limit: number; storage: 'memory' | 'redis' } {
    return {
      ttlMs: this.get('THROTTLE_TTL_SECONDS') * 1000,
      limit: this.get('THROTTLE_LIMIT'),
      storage: this.get('THROTTLE_STORAGE'),
    };
  }
  get otpHmacSecret(): string {
    return this.get('OTP_HMAC_SECRET');
  }
  get smsProvider(): SmsProviderKind {
    return this.get('SMS_PROVIDER');
  }
  get paymentProvider(): PaymentProviderKind {
    return this.get('PAYMENT_PROVIDER');
  }
  get paymentFakeWebhookSecret(): string {
    return this.get('PAYMENT_FAKE_WEBHOOK_SECRET') ?? '';
  }
  get testOtpEnabled(): boolean {
    return this.get('ALLOW_TEST_OTP');
  }
  /** Staging/demo: accept any OTP for any number, send no SMS (see DEMO_OTP_ACCEPT_ANY). Never honoured in production. */
  get demoOtpAcceptAny(): boolean {
    return !this.isProduction && this.get('DEMO_OTP_ACCEPT_ANY');
  }
  /** True only for a number on the DEMO_OTP_NUMBERS allow-list while the demo flag is on (never in production). */
  demoOtpAccepts(mobile: string): boolean {
    if (!this.demoOtpAcceptAny) return false;
    return (this.get('DEMO_OTP_NUMBERS') ?? '')
      .split(',')
      .map((n) => n.trim())
      .includes(mobile);
  }
  /** Staging/demo login for allow-listed numbers (see ALLOW_TEST_OTP). Returns the fixed code for such a number, else null. */
  testOtpCodeFor(mobile: string): string | null {
    // Defence in depth (D-70): startup already refuses the flag in production; the runtime path never honours it there either.
    if (this.isProduction || !this.get('ALLOW_TEST_OTP')) return null;
    const numbers = (this.get('TEST_OTP_NUMBERS') ?? '').split(',').map((n) => n.trim());
    return numbers.includes(mobile) ? (this.get('TEST_OTP_CODE') ?? null) : null;
  }
  /** DEC-08 retention settings. */
  get retention(): {
    enabled: boolean;
    dryRun: boolean;
    notificationsMonths: number;
    outboxDays: number;
    kycRejectedDays: number;
    deletionCoolingOffDays: number;
    batchSize: number;
    intervalMinutes: number;
  } {
    return {
      enabled: this.get('RETENTION_ENABLED'),
      dryRun: this.get('RETENTION_DRY_RUN'),
      notificationsMonths: this.get('RETENTION_NOTIFICATIONS_MONTHS'),
      outboxDays: this.get('RETENTION_OUTBOX_DAYS'),
      kycRejectedDays: this.get('RETENTION_KYC_REJECTED_DAYS'),
      deletionCoolingOffDays: this.get('DELETION_COOLING_OFF_DAYS'),
      batchSize: this.get('RETENTION_BATCH_SIZE'),
      intervalMinutes: this.get('RETENTION_INTERVAL_MINUTES'),
    };
  }
  get adminIfMatchRequired(): boolean {
    return this.get('ADMIN_IF_MATCH_REQUIRED');
  }
  get autoRefundOnCancel(): boolean {
    return this.get('AUTO_REFUND_ON_CANCEL');
  }
  /** Operational thresholds. Built-in defaults (DEC-01/02/03); 0 switches a rule off explicitly. */
  get ops(): {
    workerResponseHours: number;
    workerReassignHours: number;
    pendingPaymentAlertHours: number;
    pendingPaymentAutoCancelHours: number;
    bookingStartEarlyDays: number;
    supportSlaHours: { default: number; LOW: number; MEDIUM: number; HIGH: number };
  } {
    return {
      workerResponseHours: this.get('WORKER_RESPONSE_HOURS'),
      workerReassignHours: this.get('WORKER_REASSIGN_HOURS'),
      pendingPaymentAlertHours: this.get('PENDING_PAYMENT_ALERT_HOURS'),
      pendingPaymentAutoCancelHours: this.get('PENDING_PAYMENT_AUTO_CANCEL_HOURS'),
      bookingStartEarlyDays: this.get('BOOKING_START_EARLY_DAYS') ?? 0,
      supportSlaHours: {
        default: this.get('SUPPORT_SLA_HOURS_DEFAULT'),
        LOW: this.get('SUPPORT_SLA_HOURS_LOW'),
        MEDIUM: this.get('SUPPORT_SLA_HOURS_MEDIUM'),
        HIGH: this.get('SUPPORT_SLA_HOURS_HIGH'),
      },
    };
  }
  /** Approved policy content the client supplied; blank counts as not configured (no text is ever invented). */
  get policyContent(): {
    cancellationText?: string;
    cancellationUrl?: string;
    refundText?: string;
    refundUrl?: string;
  } {
    return {
      cancellationText: this.get('POLICY_CANCELLATION_TEXT')?.trim() || undefined,
      cancellationUrl: this.get('POLICY_CANCELLATION_URL')?.trim() || undefined,
      refundText: this.get('POLICY_REFUND_TEXT')?.trim() || undefined,
      refundUrl: this.get('POLICY_REFUND_URL')?.trim() || undefined,
    };
  }

  get legal(): {
    termsVersion?: string;
    privacyVersion?: string;
    termsUrl?: string;
    privacyUrl?: string;
    required: boolean;
  } {
    return {
      termsVersion: this.get('LEGAL_TERMS_VERSION'),
      privacyVersion: this.get('LEGAL_PRIVACY_VERSION'),
      termsUrl: this.get('LEGAL_TERMS_URL')?.trim() || undefined,
      privacyUrl: this.get('LEGAL_PRIVACY_URL')?.trim() || undefined,
      required: this.get('LEGAL_ACCEPTANCE_REQUIRED'),
    };
  }
  get appPolicy(): {
    minVersionCustomer?: string;
    minVersionWorker?: string;
    storeUrlCustomer?: string;
    storeUrlWorker?: string;
    maintenance: boolean;
    supportPhone?: string;
    supportEmail?: string;
  } {
    return {
      minVersionCustomer: this.get('APP_MIN_VERSION_CUSTOMER'),
      minVersionWorker: this.get('APP_MIN_VERSION_WORKER'),
      storeUrlCustomer: this.get('APP_STORE_URL_CUSTOMER')?.trim() || undefined,
      storeUrlWorker: this.get('APP_STORE_URL_WORKER')?.trim() || undefined,
      maintenance: this.get('APP_MAINTENANCE_MODE'),
      // A blank value counts as not configured, so the app never shows an empty "Call support" target.
      supportPhone: this.get('SUPPORT_CONTACT_PHONE')?.trim() || undefined,
      supportEmail: this.get('SUPPORT_CONTACT_EMAIL')?.trim() || undefined,
    };
  }
  get fcmServiceAccountJson(): string {
    return this.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';
  }
  get searchCacheTtlSeconds(): number {
    return this.get('SEARCH_CACHE_TTL_SECONDS');
  }
  get travelBufferMinutes(): number {
    return this.get('BOOKING_TRAVEL_BUFFER_MINUTES');
  }

  get customerAutoVerify(): boolean {
    return this.get('CUSTOMER_AUTO_VERIFY');
  }

  /** The ClamAV daemon to scan uploaded documents with; null = no scanning. */
  get clamav(): { host: string; port: number; timeoutMs: number } | null {
    const host = this.get('CLAMAV_HOST');
    return host
      ? { host, port: this.get('CLAMAV_PORT'), timeoutMs: this.get('CLAMAV_TIMEOUT_MS') }
      : null;
  }

  get providerHttpTimeoutMs(): number {
    return this.get('PROVIDER_HTTP_TIMEOUT_MS');
  }
  get twilio(): {
    accountSid: string;
    authToken: string;
    messagingServiceSid?: string;
    smsFrom?: string;
    whatsappFrom?: string;
    timeoutMs: number;
  } {
    return {
      accountSid: this.get('TWILIO_ACCOUNT_SID') ?? '',
      authToken: this.get('TWILIO_AUTH_TOKEN') ?? '',
      messagingServiceSid: this.get('TWILIO_MESSAGING_SERVICE_SID') || undefined,
      smsFrom: this.get('TWILIO_SMS_FROM') || undefined,
      whatsappFrom: this.get('TWILIO_WHATSAPP_FROM') || undefined,
      timeoutMs: this.providerHttpTimeoutMs,
    };
  }
  get msg91(): { authKey: string; otpTemplateId: string; otpVariable: string; timeoutMs: number } {
    return {
      authKey: this.get('MSG91_AUTH_KEY') ?? '',
      otpTemplateId: this.get('MSG91_OTP_TEMPLATE_ID') ?? '',
      otpVariable: this.get('MSG91_OTP_VARIABLE'),
      timeoutMs: this.providerHttpTimeoutMs,
    };
  }
  get razorpay(): { keyId: string; keySecret: string; webhookSecret: string; timeoutMs: number } {
    return {
      keyId: this.get('RAZORPAY_KEY_ID') ?? '',
      keySecret: this.get('RAZORPAY_KEY_SECRET') ?? '',
      webhookSecret: this.get('RAZORPAY_WEBHOOK_SECRET') ?? '',
      timeoutMs: this.providerHttpTimeoutMs,
    };
  }
  get pushProvider(): MessagingProviderKind {
    return this.get('PUSH_PROVIDER');
  }
  get whatsappProvider(): WhatsAppProviderKind {
    return this.get('WHATSAPP_PROVIDER');
  }
  get ratingScaleMax(): number {
    return this.get('RATING_SCALE_MAX');
  }
  /** Longest review text accepted for a new rating (default 300, D-80). */
  get ratingReviewMax(): number {
    return this.get('RATING_REVIEW_MAX_LENGTH') ?? 300;
  }
  /** Whether a REPLACED ("ended early") booking can be rated (default false, Q-102). */
  get ratingAllowEndedEarly(): boolean {
    return this.get('RATING_ALLOW_ENDED_EARLY') ?? false;
  }
  get storageProvider(): StorageProviderKind {
    return this.get('STORAGE_PROVIDER');
  }
  get storageS3(): {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  } {
    const required = (
      key:
        | 'STORAGE_S3_ENDPOINT'
        | 'STORAGE_S3_REGION'
        | 'STORAGE_S3_BUCKET'
        | 'STORAGE_S3_ACCESS_KEY_ID'
        | 'STORAGE_S3_SECRET_ACCESS_KEY',
    ): string => {
      const value = this.get(key);
      if (!value) throw new Error(`${key} is required when STORAGE_PROVIDER=s3`);
      return value;
    };
    return {
      endpoint: required('STORAGE_S3_ENDPOINT'),
      region: required('STORAGE_S3_REGION'),
      bucket: required('STORAGE_S3_BUCKET'),
      accessKeyId: required('STORAGE_S3_ACCESS_KEY_ID'),
      secretAccessKey: required('STORAGE_S3_SECRET_ACCESS_KEY'),
    };
  }
  get verificationDocuments(): {
    maxBytes: number;
    contentTypes: string[];
    signedUrlTtlSeconds: number;
  } {
    return {
      maxBytes: this.get('VERIFICATION_DOCUMENT_MAX_BYTES'),
      contentTypes: this.get('VERIFICATION_DOCUMENT_CONTENT_TYPES').split(','),
      signedUrlTtlSeconds: this.get('SIGNED_URL_TTL_SECONDS'),
    };
  }
  /** Profile photo limits; `maxBytes` is undefined until the business sets PROFILE_PHOTO_MAX_BYTES (feature stays off). Default 5 MB (DEC-10). */
  get profilePhoto(): { maxBytes: number | undefined; signedUrlTtlSeconds: number } {
    return {
      maxBytes: this.get('PROFILE_PHOTO_MAX_BYTES'),
      signedUrlTtlSeconds: this.get('SIGNED_URL_TTL_SECONDS'),
    };
  }
  get profilePhotoRequired(): boolean {
    return this.get('PROFILE_PHOTO_REQUIRED');
  }
  get otp(): OtpSettings {
    return {
      length: this.get('OTP_LENGTH'),
      ttlSeconds: this.get('OTP_TTL_SECONDS'),
      maxVerifyAttempts: this.get('OTP_MAX_VERIFY_ATTEMPTS'),
      resendCooldownSeconds: this.get('OTP_RESEND_COOLDOWN_SECONDS'),
      sendWindowSeconds: this.get('OTP_SEND_WINDOW_SECONDS'),
      maxSendsPerMobilePerWindow: this.get('OTP_MAX_SENDS_PER_MOBILE_PER_WINDOW'),
      maxRequestsPerIpPerWindow: this.get('OTP_MAX_REQUESTS_PER_IP_PER_WINDOW'),
      lockoutSeconds: this.get('OTP_LOCKOUT_SECONDS'),
    };
  }
  get adminLogin(): AdminLoginSettings {
    return {
      maxFailures: this.get('ADMIN_LOGIN_MAX_FAILURES'),
      failureWindowSeconds: this.get('ADMIN_LOGIN_FAILURE_WINDOW_SECONDS'),
      lockoutSeconds: this.get('ADMIN_LOGIN_LOCKOUT_SECONDS'),
      passwordMinLength: this.get('ADMIN_PASSWORD_MIN_LENGTH'),
    };
  }
  /** Empty = no allow-list configured (any well-formed language code is accepted). */
  get supportedLanguages(): string[] {
    return (this.get('SUPPORTED_LANGUAGES') ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0);
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
