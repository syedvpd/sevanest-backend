import { MetaController } from './meta.controller';

describe('BUG-CUST-002 & BUG-CUST-018: App Config Legal URLs and Support Contact', () => {
  let controller: MetaController;
  let mockLegal: { current: jest.Mock };
  let mockPlatform: { effective: jest.Mock };
  let mockConfig: { supportedLanguages: string[] };

  beforeEach(() => {
    mockConfig = { supportedLanguages: ['en', 'hi'] };
    mockLegal = {
      current: jest.fn(),
    };
    mockPlatform = {
      effective: jest.fn(),
    };

    controller = new MetaController(
      mockConfig as never,
      mockLegal as never,
      mockPlatform as never,
      {} as never,
    );
  });

  it('safely returns null for legal URLs and support contact when unconfigured (missing-value behavior)', async () => {
    mockLegal.current.mockReturnValue({
      acceptanceRequired: false,
      terms: null,
      privacy: null,
    });
    mockPlatform.effective.mockResolvedValue({
      customerMinVersion: null,
      customerStoreUrl: null,
      workerMinVersion: null,
      workerStoreUrl: null,
      maintenance: false,
      supportPhone: null,
      supportEmail: null,
      cancellationPolicyText: null,
      cancellationPolicyUrl: null,
      refundPolicyText: null,
      refundPolicyUrl: null,
    });

    const result = await controller.appConfig();

    expect(result.support).toEqual({ phone: null, email: null });
    expect(result.legal.terms).toBeNull();
    expect(result.legal.privacy).toBeNull();
    expect(result.policy.cancellationUrl).toBeNull();
  });

  it('returns configured legal URLs and support contact details when supplied by business or admin', async () => {
    mockLegal.current.mockReturnValue({
      acceptanceRequired: true,
      terms: { version: '1.0', url: 'https://sevanest.com/legal/terms' },
      privacy: { version: '1.0', url: 'https://sevanest.com/legal/privacy' },
    });
    mockPlatform.effective.mockResolvedValue({
      customerMinVersion: '1.0.0',
      customerStoreUrl: 'https://play.google.com/store/apps/details?id=com.sevanest.customer',
      workerMinVersion: '1.0.0',
      workerStoreUrl: 'https://play.google.com/store/apps/details?id=com.sevanest.worker',
      maintenance: false,
      supportPhone: '+919876543210',
      supportEmail: 'support@sevanest.com',
      cancellationPolicyText: 'Free cancellation up to 2 hours before start',
      cancellationPolicyUrl: 'https://sevanest.com/policy/cancellation',
      refundPolicyText: 'Refunds processed within 5-7 business days',
      refundPolicyUrl: 'https://sevanest.com/policy/refund',
    });

    const result = await controller.appConfig();

    expect(result.support).toEqual({
      phone: '+919876543210',
      email: 'support@sevanest.com',
    });
    expect(result.legal.terms?.url).toBe('https://sevanest.com/legal/terms');
    expect(result.legal.privacy?.url).toBe('https://sevanest.com/legal/privacy');
    expect(result.policy.cancellationUrl).toBe('https://sevanest.com/policy/cancellation');
  });

  it('resiliently serves environment config when database or platform settings throw (cold start / DB failover)', async () => {
    mockLegal.current.mockReturnValue({
      acceptanceRequired: false,
      terms: null,
      privacy: null,
    });
    mockPlatform.effective.mockRejectedValue(new Error('Connection terminated unexpectedly'));

    // MetaController falls back to default empty/env settings instead of crashing or returning 503
    const result = await controller.appConfig();
    expect(result).toBeDefined();
    expect(result.maintenance).toBe(false);
    expect(result.customer.minVersion).toBeNull();
    expect(result.support.phone).toBeNull();
    expect(result.languages).toEqual(['en', 'hi']);
  });
});
