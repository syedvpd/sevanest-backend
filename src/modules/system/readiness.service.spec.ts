import { EVENT_PARAMS } from '../../common/outbox/notification-events';
import {
  EmailProviderKind,
  MessagingProviderKind,
  PaymentProviderKind,
  SmsProviderKind,
  StorageProviderKind,
  WhatsAppProviderKind,
} from '../../config/env.validation';
import { ReadinessService } from './readiness.service';

describe('ReadinessService push templates (D-104)', () => {
  const staffOnly = 'PAYMENT_EXCEPTION_ALERT';
  const customerEvents = Object.keys(EVENT_PARAMS).filter((event) => event !== staffOnly);

  let templates: Array<{ eventCode: string; channel: string }>;
  let pushProvider: MessagingProviderKind;
  let service: ReadinessService;

  const prisma = {
    serviceArea: { count: jest.fn(() => Promise.resolve(1)) },
    serviceCategory: { count: jest.fn(() => Promise.resolve(1)) },
    verificationRequirement: { count: jest.fn(() => Promise.resolve(1)) },
    feeConfig: { findUnique: jest.fn(() => Promise.resolve({ isActive: true })) },
    supportCategory: { count: jest.fn(() => Promise.resolve(1)) },
    notificationTemplate: { findMany: jest.fn(() => Promise.resolve(templates)) },
    role: { findMany: jest.fn(() => Promise.resolve([])) },
    user: { count: jest.fn(() => Promise.resolve(1)) },
  };

  const config = {
    testOtpEnabled: false,
    demoOtpAcceptAny: false,
    smsProvider: SmsProviderKind.Twilio,
    paymentProvider: PaymentProviderKind.Razorpay,
    storageProvider: StorageProviderKind.S3,
    clamav: {},
    get pushProvider(): MessagingProviderKind {
      return pushProvider;
    },
    whatsappProvider: WhatsAppProviderKind.Twilio,
    emailProvider: EmailProviderKind.Brevo,
    ops: {
      pendingPaymentAlertHours: 1,
      pendingPaymentAutoCancelHours: 1,
      workerResponseHours: 1,
      workerReassignHours: 1,
      supportSlaHours: { default: 1 },
    },
    legal: { required: true, termsVersion: '1', privacyVersion: '1' },
  };

  beforeEach(() => {
    pushProvider = MessagingProviderKind.Fcm;
    templates = customerEvents.map((eventCode) => ({ eventCode, channel: 'IN_APP' }));
    service = new ReadinessService(
      prisma as never,
      config as never,
      {
        alive: jest.fn(() => Promise.resolve(null)),
      } as never,
    );
  });

  it('warns that in-app wording alone queues no push when PUSH is on', async () => {
    const report = await service.report();
    const check = report.checks.find((c) => c.key === 'notification_push_templates');

    expect(check).toBeDefined();
    expect(check?.level).toBe('WARNING');
    expect(check?.ok).toBe(false);
    expect(check?.message).toContain('No active PUSH template for');
    expect(check?.message).toContain(customerEvents[0]);
    expect(check?.message).not.toContain(staffOnly);
  });

  it('passes when every customer/worker event has an active PUSH template', async () => {
    templates = customerEvents.map((eventCode) => ({ eventCode, channel: 'PUSH' }));

    const report = await service.report();
    const check = report.checks.find((c) => c.key === 'notification_push_templates');

    expect(check?.ok).toBe(true);
    expect(check?.message).toBe('Every event has an active PUSH template');
  });

  it('does not add the push-template check when PUSH_PROVIDER is not FCM', async () => {
    pushProvider = MessagingProviderKind.Disabled;

    const report = await service.report();

    expect(report.checks.some((c) => c.key === 'notification_push_templates')).toBe(false);
    expect(report.checks.some((c) => c.key === 'notification_templates')).toBe(true);
  });
});
