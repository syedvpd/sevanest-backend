import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { MessagingProviderKind } from '../../config/env.validation';
import { ProviderError } from '../../integrations/provider-error';
import { InvalidDeviceTokenError } from '../../integrations/notifications/notification-providers.interface';
import { NotificationsService } from './notifications.service';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';

describe('NotificationsService testPush (D-104)', () => {
  const DEVICE_TOKEN = 'fcm-token-abcdef1234567890';

  let service: NotificationsService;
  let mockRepository: {
    createTestPushNotification: jest.Mock;
    finish: jest.Mock;
    findById: jest.Mock;
  };
  let mockSessions: {
    listDeviceTokens: jest.Mock<Promise<string[]>, [string]>;
    removeDeviceToken: jest.Mock<Promise<number>, [string]>;
  };
  let mockAudit: {
    record: jest.Mock<Promise<void>, [unknown]>;
  };
  let mockPush: {
    sendPush: jest.Mock<Promise<{ providerMessageId: string }>, [unknown]>;
  };
  let mockConfig: {
    isProduction: boolean;
    allowTestPush: boolean;
    pushProvider: MessagingProviderKind;
    firebaseProjectId: string;
  };

  const workerUser: AuthenticatedUser = {
    userId: 'user-worker-1',
    sessionId: 'session-1',
    type: 'WORKER',
  };

  const adminUser: AuthenticatedUser = {
    userId: 'user-admin-1',
    sessionId: 'session-2',
    type: 'ADMIN',
  };

  beforeEach(() => {
    mockRepository = {
      createTestPushNotification: jest.fn().mockImplementation((input) =>
        Promise.resolve({
          id: input.id,
          recipientUserId: input.recipientUserId,
          eventCode: 'TEST_PUSH',
          channel: 'PUSH',
          status: 'QUEUED',
          params: { title: input.title, body: input.body },
        }),
      ),
      finish: jest.fn().mockResolvedValue(true),
      findById: jest.fn(),
    };
    mockSessions = {
      listDeviceTokens: jest.fn<Promise<string[]>, [string]>(() => Promise.resolve([DEVICE_TOKEN])),
      removeDeviceToken: jest.fn<Promise<number>, [string]>(() => Promise.resolve(1)),
    };
    mockAudit = {
      record: jest.fn<Promise<void>, [unknown]>(() => Promise.resolve()),
    };
    mockPush = {
      sendPush: jest.fn<Promise<{ providerMessageId: string }>, [unknown]>(() =>
        Promise.resolve({ providerMessageId: 'projects/sevanest-47cef/messages/msg-1' }),
      ),
    };
    mockConfig = {
      isProduction: false,
      allowTestPush: false,
      pushProvider: MessagingProviderKind.Fcm,
      firebaseProjectId: 'sevanest-47cef',
    };

    service = new NotificationsService(
      mockRepository as never,
      {} as never,
      {} as never,
      mockSessions as never,
      mockAudit as never,
      {} as never,
      {} as never,
      mockPush,
      {} as never,
      {} as never,
      mockConfig as never,
    );
  });

  it('restricts test-push in production for non-admin users when allowTestPush=false', async () => {
    mockConfig.isProduction = true;
    mockConfig.allowTestPush = false;

    await expect(service.testPush(workerUser)).rejects.toThrow(DomainException);
    try {
      await service.testPush(workerUser);
    } catch (err: unknown) {
      expect((err as DomainException).code).toBe('TEST_PUSH_RESTRICTED');
      expect((err as DomainException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
    expect(mockPush.sendPush).not.toHaveBeenCalled();
  });

  it('allows test-push in production for admin users', async () => {
    mockConfig.isProduction = true;
    mockConfig.allowTestPush = false;

    const res = await service.testPush(adminUser);
    expect(res.success).toBe(true);
    expect(res.stage).toBe('DISPATCHED');
  });

  it('allows test-push in production for workers when allowTestPush=true', async () => {
    mockConfig.isProduction = true;
    mockConfig.allowTestPush = true;

    const res = await service.testPush(workerUser);
    expect(res.success).toBe(true);
    expect(res.stage).toBe('DISPATCHED');
  });

  it('diagnoses missing device token and points at the PUT device-token route', async () => {
    mockSessions.listDeviceTokens.mockResolvedValueOnce([]);

    const res = await service.testPush(workerUser);
    expect(res.success).toBe(false);
    expect(res.stage).toBe('NO_DEVICE_TOKEN');
    expect(res.diagnostic_id).toBe(res.correlationId);
    expect(res.firebase_initialized).toBe(true);
    expect(res.registration_found).toBe(false);
    expect(res.active_token_count).toBe(0);
    expect(res.dispatch_attempted).toBe(false);
    expect(res.result).toBe('NO_ACTIVE_DEVICE_TOKEN');
    expect(res.tokensCount).toBe(0);
    expect(res.tokens).toEqual([]);
    expect(res.diagnostics.tokenRegistered).toBe(false);
    expect(res.message).toContain('PUT /api/v1/auth/device-token');
    expect(res.message).not.toContain('POST /api/v1/auth/device-token');
    expect(res.diagnostics.troubleshootingRecommendation).toContain('ISSUE IS IN APP');
    expect(mockPush.sendPush).not.toHaveBeenCalled();
  });

  it('diagnoses backend configuration error when push provider is disabled', async () => {
    mockConfig.pushProvider = MessagingProviderKind.Disabled;

    const res = await service.testPush(workerUser);
    expect(res.success).toBe(false);
    expect(res.stage).toBe('CONFIG_ERROR');
    expect(res.firebase_initialized).toBe(false);
    expect(res.registration_found).toBe(true);
    expect(res.active_token_count).toBe(1);
    expect(res.dispatch_attempted).toBe(false);
    expect(res.result).toBe('FIREBASE_NOT_INITIALIZED');
    expect(res.tokensCount).toBe(1);
    expect(res.tokens[0].error).toBe('PUSH_PROVIDER_DISABLED');
    expect(res.correlationId).toBeTruthy();
    expect(res.diagnostics.fcmConfigured).toBe(false);
    expect(res.diagnostics.troubleshootingRecommendation).toContain('ISSUE IS IN BACKEND');
    expect(mockPush.sendPush).not.toHaveBeenCalled();
  });

  it('dispatches with default wording, generates a correlation id, and masks the token', async () => {
    const res = await service.testPush(workerUser);
    const generated = res.correlationId;

    expect(res.success).toBe(true);
    expect(res.stage).toBe('DISPATCHED');
    expect(res.diagnostic_id).toBe(generated);
    expect(res.firebase_initialized).toBe(true);
    expect(res.registration_found).toBe(true);
    expect(res.active_token_count).toBe(1);
    expect(res.dispatch_attempted).toBe(true);
    expect(res.firebase_accepted_count).toBe(1);
    expect(res.firebase_failure_count).toBe(0);
    expect(res.result).toBe('FCM_ACCEPTED');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.tokensCount).toBe(1);
    expect(res.tokens[0].status).toBe('DELIVERED');
    expect(res.tokens[0].providerMessageId).toBe('projects/sevanest-47cef/messages/msg-1');
    expect(res.tokens[0].token).toBe('fcm-to...567890');
    expect(JSON.stringify(res)).not.toContain(DEVICE_TOKEN);
    expect(res.diagnostics.deliveredCount).toBe(1);
    expect(res.diagnostics.failedCount).toBe(0);
    expect(res.diagnostics.foregroundHandlingNote).toContain('sevanest_high_importance');
    expect(res.diagnostics.backgroundHandlingNote).toContain('notification drawer');

    expect(mockPush.sendPush).toHaveBeenCalledWith({
      deviceToken: DEVICE_TOKEN,
      title: 'SevaNest Test Notification',
      body: 'Your push notification setup is working successfully!',
      data: expect.objectContaining({
        type: 'TEST_PUSH',
        event: 'TEST_PUSH',
        channelId: 'sevanest_high_importance',
        priority: 'high',
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
      }),
    });

    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.test_push',
        actorId: 'user-worker-1',
        actorRole: 'WORKER',
        metadata: expect.objectContaining({
          correlationId: generated,
          targetUserId: 'user-worker-1',
          targetIsActor: true,
        }),
      }),
    );
  });

  it('accepts custom title, body and a caller correlation id, echoing it back and auditing it', async () => {
    const res = await service.testPush(workerUser, {
      title: 'Custom Diagnostics Test',
      body: 'Diagnostics check from Flutter worker app',
      correlationId: 'flutter-diag-42',
    });

    expect(res.success).toBe(true);
    expect(res.correlationId).toBe('flutter-diag-42');
    expect(mockPush.sendPush).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Custom Diagnostics Test',
        body: 'Diagnostics check from Flutter worker app',
      }),
    );
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ correlationId: 'flutter-diag-42' }),
      }),
    );
  });

  it('cleans up a dead device token when FCM returns InvalidDeviceTokenError', async () => {
    mockPush.sendPush.mockRejectedValueOnce(new InvalidDeviceTokenError('fcm'));

    const res = await service.testPush(workerUser);

    expect(res.success).toBe(false);
    expect(res.stage).toBe('FAILED');
    expect(res.tokens[0].status).toBe('FAILED');
    expect(res.tokens[0].error).toContain('INVALID_REGISTRATION_TOKEN');
    expect(mockSessions.removeDeviceToken).toHaveBeenCalledWith(DEVICE_TOKEN);
  });

  it('maps an unexpected dispatch failure to a stable code instead of provider text', async () => {
    mockPush.sendPush.mockRejectedValueOnce(new Error('Network timeout contacting FCM'));

    const res = await service.testPush(workerUser);

    expect(res.success).toBe(false);
    expect(res.stage).toBe('FAILED');
    expect(res.tokens[0].status).toBe('FAILED');
    expect(res.tokens[0].error).toBe('DISPATCH_FAILED');
    expect(JSON.stringify(res)).not.toContain('Network timeout');
  });

  it.each([
    [true, 'PROVIDER_UNAVAILABLE'],
    [false, 'PROVIDER_REJECTED'],
  ])('maps a ProviderError (retryable=%s) to %s', async (retryable, code) => {
    mockPush.sendPush.mockRejectedValueOnce(
      new ProviderError('fcm', 'fcm answered HTTP 503', retryable),
    );

    const res = await service.testPush(workerUser);

    expect(res.tokens[0].error).toBe(code);
    expect(res.diagnostics.troubleshootingRecommendation).toContain(res.correlationId);
  });

  it('identifies SENDER_ID_MISMATCH and provides specific project-matching recommendation', async () => {
    mockPush.sendPush.mockRejectedValueOnce(
      new ProviderError('fcm', 'fcm rejected the request (HTTP 403)', false, {
        status: 403,
        json: {
          error: {
            code: 403,
            message: 'SenderId mismatch',
            status: 'PERMISSION_DENIED',
            details: [{ errorCode: 'SENDER_ID_MISMATCH' }],
          },
        },
      }),
    );

    const res = await service.testPush(workerUser);

    expect(res.tokens[0].error).toBe('SENDER_ID_MISMATCH');
    expect(res.diagnostics.troubleshootingRecommendation).toContain('SENDER_ID_MISMATCH');
    expect(res.diagnostics.troubleshootingRecommendation).toContain(mockConfig.firebaseProjectId);
  });

  it('admin variant targets the explicit user, never the caller, and audits both ids', async () => {
    mockConfig.isProduction = true;
    mockConfig.allowTestPush = false;

    const res = await service.adminTestPush(adminUser, {
      userId: 'user-customer-9',
      correlationId: 'admin-diag-7',
    });

    expect(res.success).toBe(true);
    expect(res.correlationId).toBe('admin-diag-7');
    expect(mockSessions.listDeviceTokens).toHaveBeenCalledWith('user-customer-9');
    expect(mockSessions.listDeviceTokens).not.toHaveBeenCalledWith('user-admin-1');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'user-admin-1',
        actorRole: 'ADMIN',
        metadata: expect.objectContaining({
          correlationId: 'admin-diag-7',
          targetUserId: 'user-customer-9',
          targetIsActor: false,
        }),
      }),
    );
  });

  it('persists test push notification in repository before dispatch and marks it SENT on delivery', async () => {
    const res = await service.testPush(workerUser);

    expect(res.success).toBe(true);
    expect(mockRepository.createTestPushNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        recipientUserId: 'user-worker-1',
        title: 'SevaNest Test Notification',
        body: 'Your push notification setup is working successfully!',
        correlationId: res.correlationId,
      }),
    );

    const persistedId = mockRepository.createTestPushNotification.mock.calls[0][0].id;

    // FCM data payload must carry this exact notificationId for client ACK
    expect(mockPush.sendPush).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notificationId: persistedId,
          routeId: persistedId,
        }),
      }),
    );

    // Repository finish is called with SENT and providerMessageId
    expect(mockRepository.finish).toHaveBeenCalledWith(persistedId, {
      status: 'SENT',
      providerMessageId: 'projects/sevanest-47cef/messages/msg-1',
      lastError: null,
    });
  });

  it('marks test notification FAILED in repository when dispatch fails', async () => {
    mockPush.sendPush.mockRejectedValueOnce(new Error('FCM unreachable'));

    const res = await service.testPush(workerUser);

    expect(res.success).toBe(false);
    const persistedId = mockRepository.createTestPushNotification.mock.calls[0][0].id;
    expect(mockRepository.finish).toHaveBeenCalledWith(persistedId, {
      status: 'FAILED',
      providerMessageId: null,
      lastError: 'DISPATCH_FAILED',
    });
  });
});
