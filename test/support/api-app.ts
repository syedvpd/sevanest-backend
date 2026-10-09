import { createHash, randomInt } from 'node:crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AppConfigService } from '../../src/config/app-config.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { InMemorySmsProvider } from '../../src/integrations/notifications/in-memory-sms.provider';
import { InMemoryStorageProvider } from '../../src/integrations/storage/in-memory-storage.provider';
import { STORAGE_PROVIDER } from '../../src/integrations/storage/storage-provider.interface';
import { SMS_PROVIDER } from '../../src/integrations/notifications/notification-providers.interface';
import type { SmsProvider } from '../../src/integrations/notifications/notification-providers.interface';
import { AdminRoleCode } from '../../src/modules/users/rbac.constants';
import type { AdminRoleCodeValue } from '../../src/modules/users/rbac.constants';
import { CategorySeedService } from '../../src/modules/service-categories/category-seed.service';
import { RbacSeedService } from '../../src/modules/users/rbac-seed.service';
import { UsersService } from '../../src/modules/users/users.service';

export const ADMIN_PASSWORD = 'correct horse battery staple 9!';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
  mobile?: string;
  email?: string;
}

export interface ApiApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  redis: RedisService;
  config: AppConfigService;
  users: UsersService;
  sms: InMemorySmsProvider;
  storage: InMemoryStorageProvider;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule + configureApp() against the real PostgreSQL and Redis (nothing stubbed). Only the SMS
 * adapter may be replaced, to simulate provider failure. Import test/support/env-api-integration FIRST in the spec.
 */
export async function createApiApp(options: { smsProvider?: SmsProvider } = {}): Promise<ApiApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.smsProvider) {
    builder = builder.overrideProvider(SMS_PROVIDER).useValue(options.smsProvider);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app, app.get(AppConfigService));
  await app.init();
  // Tests fire many parallel requests at one in-process server; that is not a listener leak.
  app.getHttpServer().setMaxListeners(100);
  await app.get(RbacSeedService).ensureReferenceData();
  await app.get(CategorySeedService).ensureInitialCategories();

  return {
    app,
    prisma: app.get(PrismaService),
    redis: app.get(RedisService),
    config: app.get(AppConfigService),
    users: app.get(UsersService),
    sms: app.get<InMemorySmsProvider>(SMS_PROVIDER),
    storage: app.get<InMemoryStorageProvider>(STORAGE_PROVIDER),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

/** A fresh valid Indian mobile in canonical E.164 form. */
export function randomMobile(): string {
  return `+91${randomInt(6, 10)}${String(randomInt(0, 1e9)).padStart(9, '0')}`;
}

/** A fresh client IP (TRUST_PROXY_HOPS=1 makes the API read it from X-Forwarded-For). */
export function randomIp(): string {
  return `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

export function unique(): string {
  return `${Date.now().toString(36)}${randomInt(0, 1e6).toString(36)}`;
}

export function otpKeyId(mobile: string): string {
  return createHash('sha256').update(mobile).digest('hex').slice(0, 32);
}

export function otpFromSms(api: ApiApp, mobile: string): string {
  const message = api.sms.lastTo(mobile);
  const match = message ? /\b(\d{4,10})\b/.exec(message.body) : null;
  if (!match) {
    throw new Error(`No OTP SMS captured for ${mobile}`);
  }
  return match[1];
}

export async function requestOtp(
  api: ApiApp,
  mobile: string,
  appType: 'CUSTOMER' | 'WORKER' = 'CUSTOMER',
  ip: string = randomIp(),
): Promise<request.Response> {
  return api
    .http()
    .post('/api/v1/auth/otp/request')
    .set('X-Forwarded-For', ip)
    .send({ mobile, appType });
}

/** Full OTP login through the public API. Returns tokens plus the identifiers used. */
export async function loginWithOtp(
  api: ApiApp,
  options: {
    mobile?: string;
    appType?: 'CUSTOMER' | 'WORKER';
    deviceId?: string;
    ip?: string;
  } = {},
): Promise<Tokens & { isNewUser: boolean; type: string; sessionId: string }> {
  const mobile = options.mobile ?? randomMobile();
  const appType = options.appType ?? 'CUSTOMER';
  const ip = options.ip ?? randomIp();
  const requested = await requestOtp(api, mobile, appType, ip);
  if (requested.status !== 200) {
    throw new Error(`OTP request failed: ${requested.status} ${JSON.stringify(requested.body)}`);
  }
  // A repeat login for the same number inside the resend cooldown is a test concern, not an API one.
  const verified = await api
    .http()
    .post('/api/v1/auth/otp/verify')
    .set('X-Forwarded-For', ip)
    .send({ mobile, appType, otp: otpFromSms(api, mobile), deviceId: options.deviceId });
  if (verified.status !== 200) {
    throw new Error(`OTP verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  const body = verified.body as {
    accessToken: string;
    refreshToken: string;
    user: { id: string; type: string; isNewUser: boolean };
  };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    mobile,
    isNewUser: body.user.isNewUser,
    type: body.user.type,
    sessionId: sessionIdFromToken(body.accessToken),
  };
}

export function sessionIdFromToken(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
    sid: string;
  };
  return payload.sid;
}

export function bearer(tokens: { accessToken: string }): string {
  return `Bearer ${tokens.accessToken}`;
}

/** Creates an admin directly through the Users service (bypassing HTTP) and returns its credentials. */
export async function createAdmin(
  api: ApiApp,
  roleCode: AdminRoleCodeValue = AdminRoleCode.SUPER_ADMIN,
): Promise<{ id: string; email: string; password: string }> {
  const email = `admin.${unique()}@example.test`;
  const user = await api.users.provisionAdmin(
    { email, password: ADMIN_PASSWORD, roleCode },
    { userId: null, roles: ['SYSTEM_BOOTSTRAP'] },
  );
  return { id: user.id, email, password: ADMIN_PASSWORD };
}

export async function adminLogin(
  api: ApiApp,
  credentials: { email: string; password: string },
  ip: string = randomIp(),
): Promise<request.Response> {
  return api
    .http()
    .post('/api/v1/auth/admin/login')
    .set('X-Forwarded-For', ip)
    .send({ email: credentials.email, password: credentials.password });
}

export async function loginAdmin(
  api: ApiApp,
  roleCode: AdminRoleCodeValue = AdminRoleCode.SUPER_ADMIN,
): Promise<Tokens & { password: string; sessionId: string }> {
  const admin = await createAdmin(api, roleCode);
  const res = await adminLogin(api, admin);
  if (res.status !== 200) {
    throw new Error(`Admin login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { accessToken: string; refreshToken: string };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: admin.id,
    email: admin.email,
    password: admin.password,
    sessionId: sessionIdFromToken(body.accessToken),
  };
}

/**
 * Gives an admin a one-off role holding exactly the listed permissions, to test "wrong role" and "missing
 * permission" against the real RBAC tables. The role is test data in the dedicated test database.
 */
export async function loginAdminWithPermissions(
  api: ApiApp,
  permissionCodes: string[],
): Promise<Tokens & { password: string; sessionId: string }> {
  const roleCode = `TEST_${unique()}`.toUpperCase();
  const permissions = await api.prisma.permission.findMany({
    where: { code: { in: permissionCodes } },
    select: { id: true },
  });
  const role = await api.prisma.role.create({
    data: {
      code: roleCode,
      name: roleCode,
      permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
    },
    select: { id: true },
  });
  const admin = await createAdmin(api, AdminRoleCode.OPERATIONS_ADMIN);
  await api.prisma.userRole.deleteMany({ where: { userId: admin.id } });
  await api.prisma.userRole.create({ data: { userId: admin.id, roleId: role.id } });
  const res = await adminLogin(api, admin);
  const body = res.body as { accessToken: string; refreshToken: string };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: admin.id,
    email: admin.email,
    password: admin.password,
    sessionId: sessionIdFromToken(body.accessToken),
  };
}

/** Clears Redis protection state for an admin email/IP so lockout tests do not leak into each other. */
export async function clearAdminLockout(api: ApiApp, email: string, ip?: string): Promise<void> {
  await api.redis.ensureConnected();
  const id = createHash('sha256').update(email).digest('hex').slice(0, 32);
  const keys = [
    `auth:admin:fail:acct:${id}`,
    `auth:admin:lock:acct:${id}`,
    ...(ip ? [`auth:admin:fail:ip:${ip}`, `auth:admin:lock:ip:${ip}`] : []),
  ];
  await api.redis.client.del(...keys);
}
