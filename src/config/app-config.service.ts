import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EnvironmentVariables,
  MessagingProviderKind,
  WhatsAppProviderKind,
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
  /** Operational thresholds. Every value is optional: unset means the rule is not enforced (nothing is invented). */
  get ops(): {
    workerResponseHours?: number;
    pendingPaymentAlertHours?: number;
    pendingPaymentAutoCancelHours?: number;
    supportSlaHours: { default?: number; LOW?: number; MEDIUM?: number; HIGH?: number };
  } {
    return {
      workerResponseHours: this.get('WORKER_RESPONSE_HOURS'),
      pendingPaymentAlertHours: this.get('PENDING_PAYMENT_ALERT_HOURS'),
      pendingPaymentAutoCancelHours: this.get('PENDING_PAYMENT_AUTO_CANCEL_HOURS'),
      supportSlaHours: {
        default: this.get('SUPPORT_SLA_HOURS_DEFAULT'),
        LOW: this.get('SUPPORT_SLA_HOURS_LOW'),
        MEDIUM: this.get('SUPPORT_SLA_HOURS_MEDIUM'),
        HIGH: this.get('SUPPORT_SLA_HOURS_HIGH'),
      },
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
      termsUrl: this.get('LEGAL_TERMS_URL'),
      privacyUrl: this.get('LEGAL_PRIVACY_URL'),
      required: this.get('LEGAL_ACCEPTANCE_REQUIRED'),
    };
  }
  get appPolicy(): {
    minVersionCustomer?: string;
    minVersionWorker?: string;
    maintenance: boolean;
    supportPhone?: string;
    supportEmail?: string;
  } {
    return {
      minVersionCustomer: this.get('APP_MIN_VERSION_CUSTOMER'),
      minVersionWorker: this.get('APP_MIN_VERSION_WORKER'),
      maintenance: this.get('APP_MAINTENANCE_MODE'),
      supportPhone: this.get('SUPPORT_CONTACT_PHONE'),
      supportEmail: this.get('SUPPORT_CONTACT_EMAIL'),
    };
  }
  get fcmServiceAccountJson(): string {
    return this.get('FCM_SERVICE_ACCOUNT_JSON') ?? '';
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
  /** Profile photo limits; `maxBytes` is undefined until the business sets PROFILE_PHOTO_MAX_BYTES (feature stays off). */
  get profilePhoto(): { maxBytes: number | undefined; signedUrlTtlSeconds: number } {
    return {
      maxBytes: this.get('PROFILE_PHOTO_MAX_BYTES'),
      signedUrlTtlSeconds: this.get('SIGNED_URL_TTL_SECONDS'),
    };
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
