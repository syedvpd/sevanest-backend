import { Injectable } from '@nestjs/common';
import { EVENT_PARAMS } from '../../common/outbox/notification-events';
import { AppConfigService } from '../../config/app-config.service';
import {
  MessagingProviderKind,
  PaymentProviderKind,
  SmsProviderKind,
  StorageProviderKind,
  WhatsAppProviderKind,
} from '../../config/env.validation';
import { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { AdminRoleCode } from '../users/rbac.constants';
import { PrismaService } from '../../infrastructure/database/prisma.service';

export interface ReadinessCheck {
  key: string;
  /** BLOCKER = the platform cannot work for real users until fixed; WARNING = degraded or optional. */
  level: 'BLOCKER' | 'WARNING';
  ok: boolean;
  message: string;
}

export interface ReadinessReport {
  ready: boolean;
  blockers: number;
  warnings: number;
  checks: ReadinessCheck[];
  workers: Array<{ name: string; lastSeen: string }> | null;
}

/** Loops the worker process runs; each should have a recent heartbeat when a worker (or EMBEDDED_WORKERS) is running. */
export const EXPECTED_LOOPS = [
  'notifications',
  'recheck-reminders',
  'abandoned-uploads',
  'payment-recovery',
  'booking-checks',
  'support-sla',
] as const;

/**
 * "A fresh deploy silently does nothing until prerequisite data exists." This lists every prerequisite and whether it is met, so the
 * answer is one request instead of a support ticket. Read-only; it changes nothing and exposes no secret (provider names only).
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly heartbeat: HeartbeatService,
  ) {}

  async report(): Promise<ReadinessReport> {
    const [
      areas,
      categories,
      requirements,
      fee,
      supportCategories,
      templates,
      alive,
      roles,
      superAdmins,
    ] = await Promise.all([
      this.prisma.serviceArea.count({ where: { isEnabled: true } }),
      this.prisma.serviceCategory.count({ where: { isEnabled: true } }),
      this.prisma.verificationRequirement.count(),
      this.prisma.feeConfig.findUnique({ where: { code: 'BOOKING_FEE' } }),
      this.prisma.supportCategory.count({ where: { isEnabled: true } }),
      this.prisma.notificationTemplate.findMany({
        where: { isActive: true },
        select: { eventCode: true, channel: true },
      }),
      this.heartbeat.alive(),
      this.prisma.role.findMany({
        where: { code: { in: Object.values(AdminRoleCode) } },
        select: { code: true, _count: { select: { permissions: true } } },
      }),
      this.prisma.user.count({
        where: {
          status: 'ACTIVE',
          roles: { some: { role: { code: AdminRoleCode.SUPER_ADMIN } } },
        },
      }),
    ]);
    const checks: ReadinessCheck[] = [];
    const add = (
      key: string,
      level: ReadinessCheck['level'],
      ok: boolean,
      message: string,
    ): void => {
      checks.push({ key, level, ok, message });
    };

    add(
      'service_areas',
      'BLOCKER',
      areas > 0,
      areas > 0 ? `${areas} enabled` : 'No enabled service area: nobody can search or book',
    );
    add(
      'service_categories',
      'BLOCKER',
      categories > 0,
      categories > 0 ? `${categories} enabled` : 'No enabled service category',
    );
    add(
      'verification_requirements',
      'BLOCKER',
      requirements > 0,
      requirements > 0
        ? `${requirements} required checks`
        : 'No verification requirement is set: no worker can count as verified, so nobody is searchable (Q-04)',
    );
    add(
      'booking_fee',
      'BLOCKER',
      !!fee?.isActive,
      fee?.isActive
        ? 'Booking fee configured'
        : 'No active BOOKING_FEE: paying a booking fails after the customer confirmed a worker (Q-01)',
    );
    add(
      'support_categories',
      'WARNING',
      supportCategories > 0,
      supportCategories > 0
        ? `${supportCategories} enabled`
        : 'No support category: tickets cannot be raised',
    );

    add(
      'super_admin',
      'BLOCKER',
      superAdmins > 0,
      superAdmins > 0
        ? `${superAdmins} active Super Admin(s)`
        : 'No active Super Admin: run `npm run bootstrap:admin` on the server',
    );
    const emptyRoles = roles.filter((r) => r._count.permissions === 0).map((r) => r.code);
    add(
      'admin_role_permissions',
      'WARNING',
      emptyRoles.length === 0,
      emptyRoles.length === 0
        ? 'Every admin role has permissions'
        : `Admin roles without any permission: ${emptyRoles.join(', ')}. Staff holding them can do nothing. Run \`npm run seed\` to apply the D-71 starting sets, or set them with PUT /admin/roles/{code}/permissions`,
    );
    add(
      'test_otp',
      'WARNING',
      !this.config.testOtpEnabled,
      this.config.testOtpEnabled
        ? 'ALLOW_TEST_OTP is on: listed test numbers log in with a fixed code. Turn it off before real users arrive'
        : 'Test OTP login is off',
    );

    const eventsWithTemplate = new Set(templates.map((t) => t.eventCode));
    // Staff alerts are shown in the admin alert inbox, which needs no template.
    const staffOnly = new Set(['PAYMENT_EXCEPTION_ALERT']);
    const without = Object.keys(EVENT_PARAMS).filter(
      (e) => !staffOnly.has(e) && !eventsWithTemplate.has(e),
    );
    add(
      'notification_templates',
      'WARNING',
      without.length === 0,
      without.length === 0
        ? 'Every event has an active template'
        : `No active template for: ${without.join(', ')} (those events notify nobody). Run \`npm run seed:launch\` for starter in-app wording`,
    );

    const real = (ok: boolean, name: string, what: string): void =>
      add(
        `provider_${name}`,
        'BLOCKER',
        ok,
        ok ? `${what} configured` : `${what} is not configured`,
      );
    real(
      this.config.smsProvider === SmsProviderKind.Twilio ||
        this.config.smsProvider === SmsProviderKind.Msg91,
      'sms',
      'OTP SMS provider (nobody can log in by OTP without it)',
    );
    real(
      this.config.paymentProvider === PaymentProviderKind.Razorpay,
      'payment',
      'Payment gateway',
    );
    real(this.config.storageProvider === StorageProviderKind.S3, 'storage', 'KYC document storage');
    add(
      'malware_scanning',
      'WARNING',
      this.config.clamav !== null,
      this.config.clamav !== null
        ? 'Uploaded documents and photos are scanned (ClamAV)'
        : 'Uploaded documents and photos are checked for type, size and content but NOT scanned for malware (set CLAMAV_HOST)',
    );
    add(
      'provider_push',
      'WARNING',
      this.config.pushProvider === MessagingProviderKind.Fcm,
      this.config.pushProvider === MessagingProviderKind.Fcm
        ? 'Push (FCM) configured'
        : 'Push is not configured: only in-app and SMS messages can be delivered',
    );
    add(
      'provider_whatsapp',
      'WARNING',
      this.config.whatsappProvider === WhatsAppProviderKind.Twilio,
      this.config.whatsappProvider === WhatsAppProviderKind.Twilio
        ? 'WhatsApp configured'
        : 'WhatsApp is not configured (optional channel)',
    );

    const running = new Set((alive ?? []).map((l) => l.name));
    const missingLoops = EXPECTED_LOOPS.filter((l) => !running.has(l));
    add(
      'background_workers',
      'BLOCKER',
      alive !== null && missingLoops.length === 0,
      alive === null
        ? 'Could not read worker heartbeats (Redis unavailable)'
        : missingLoops.length === 0
          ? 'All background loops are running'
          : `Not seen recently: ${missingLoops.join(', ')}. Deploy the worker service (node dist/worker) or set EMBEDDED_WORKERS=true`,
    );
    const legal = this.config.legal;
    add(
      'legal_documents',
      'WARNING',
      !legal.required || (!!legal.termsVersion && !!legal.privacyVersion),
      legal.required
        ? 'Acceptance is required and versions are set'
        : 'Terms/privacy acceptance is not enforced (legal review pending)',
    );

    const blockers = checks.filter((c) => !c.ok && c.level === 'BLOCKER').length;
    const warnings = checks.filter((c) => !c.ok && c.level === 'WARNING').length;
    return { ready: blockers === 0, blockers, warnings, checks, workers: alive };
  }
}
