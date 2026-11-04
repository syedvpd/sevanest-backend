import { DomainException } from '../../common/errors/domain.exception';
import type { AuditService } from '../../common/audit/audit.service';
import type { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import type { AppConfigService } from '../../config/app-config.service';
import type {
  PushProvider,
  SmsProvider,
  WhatsAppProvider,
  EmailProvider,
} from '../../integrations/notifications/notification-providers.interface';
import type { UsersService } from '../users/users.service';
import type { SessionService } from '../auth/session.service';
import type { OutboxService } from '../../common/outbox/outbox.service';
import type { Queue } from 'bullmq';

describe('NotificationsService.acknowledge', () => {
  let service: NotificationsService;
  let mockRepository: {
    findById: jest.Mock;
    markRead: jest.Mock;
  };
  let mockAudit: {
    record: jest.Mock;
  };

  beforeEach(() => {
    mockRepository = {
      findById: jest.fn(),
      markRead: jest.fn().mockResolvedValue(true),
    };
    mockAudit = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    service = new NotificationsService(
      mockRepository as unknown as NotificationsRepository,
      {} as OutboxService,
      {} as UsersService,
      {} as SessionService,
      mockAudit as unknown as AuditService,
      {} as Queue,
      {} as SmsProvider,
      {} as PushProvider,
      {} as WhatsAppProvider,
      {} as EmailProvider,
      {} as AppConfigService,
    );
  });

  it('rejects with 404 NOTIFICATION_NOT_FOUND when notification does not exist', async () => {
    mockRepository.findById.mockResolvedValueOnce(null);

    await expect(
      service.acknowledge('user-1', 'notif-999', { eventType: 'RECEIVED' }),
    ).rejects.toThrow(DomainException);
  });

  it('rejects with 404 NOTIFICATION_NOT_FOUND when notification belongs to another user', async () => {
    mockRepository.findById.mockResolvedValueOnce({
      id: 'notif-1',
      recipientUserId: 'different-user',
      channel: 'PUSH',
      eventCode: 'JOB_OPPORTUNITY',
      readAt: null,
    });

    await expect(
      service.acknowledge('user-attacker', 'notif-1', { eventType: 'RECEIVED' }),
    ).rejects.toThrow(DomainException);
    expect(mockAudit.record).not.toHaveBeenCalled();
  });

  it('acknowledges RECEIVED and records audit telemetry without marking read', async () => {
    mockRepository.findById.mockResolvedValueOnce({
      id: 'notif-1',
      recipientUserId: 'user-1',
      channel: 'PUSH',
      eventCode: 'JOB_OPPORTUNITY',
      readAt: null,
    });

    const res = await service.acknowledge('user-1', 'notif-1', {
      eventType: 'RECEIVED',
      deviceTimestamp: '2026-11-04T12:00:00Z',
    });

    expect(res).toEqual({
      acknowledged: true,
      eventType: 'RECEIVED',
      notificationId: 'notif-1',
    });
    expect(mockRepository.markRead).not.toHaveBeenCalled();
    expect(mockAudit.record).toHaveBeenCalledWith({
      action: 'notification.acknowledged',
      entityType: 'notification',
      entityId: 'notif-1',
      actorId: 'user-1',
      actorRole: 'USER',
      metadata: {
        eventType: 'RECEIVED',
        channel: 'PUSH',
        eventCode: 'JOB_OPPORTUNITY',
        deviceTimestamp: '2026-11-04T12:00:00Z',
      },
    });
  });

  it('acknowledges TAPPED and marks notification read', async () => {
    mockRepository.findById.mockResolvedValueOnce({
      id: 'notif-2',
      recipientUserId: 'user-2',
      channel: 'PUSH',
      eventCode: 'BOOKING_CONFIRMED',
      readAt: null,
    });

    const res = await service.acknowledge('user-2', 'notif-2', {
      eventType: 'TAPPED',
    });

    expect(res).toEqual({
      acknowledged: true,
      eventType: 'TAPPED',
      notificationId: 'notif-2',
    });
    expect(mockRepository.markRead).toHaveBeenCalledWith('user-2', 'notif-2');
    expect(mockAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'notification.acknowledged',
        actorId: 'user-2',
        metadata: expect.objectContaining({
          eventType: 'TAPPED',
          channel: 'PUSH',
        }),
      }),
    );
  });
});
