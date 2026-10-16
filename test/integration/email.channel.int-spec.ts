import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import {
  EMAIL_PROVIDER,
  type EmailProvider,
} from '../../src/integrations/notifications/notification-providers.interface';
import { InMemoryEmailProvider } from '../../src/integrations/notifications/email-providers';
import { ProviderError } from '../../src/integrations/provider-error';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { ensureFee, makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const T = '/api/v1/admin/notification-templates';
const PREFS = '/api/v1/users/me/notification-preferences';

/** E-mail channel (DEC-17): template, per-user preference, memory adapter, failures never touch the business change. */
describe('E-mail channel (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let service: NotificationsService;
  let mail: InMemoryEmailProvider;

  const drain = async () => {
    for (let i = 0; i < 200; i++) if ((await service.dispatchOutbox()).events === 0) return;
  };
  const customerWithEmail = async () => {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const email = `mail.${unique()}@example.test`;
    await as(api, session)
      .post('/api/v1/customers/me', { name: 'Mail Test', email, preferredLanguage: 'en' })
      .expect(201);
    return { session, email };
  };
  const cancelledBooking = async (customer: { userId: string }) => {
    const booking = await makeBooking(api, admin, customer as never, area.id, 'MATCHED');
    await as(api, customer as never)
      .post(`/api/v1/bookings/${booking.id}/cancel`, { reason: 'plans changed' })
      .expect(200);
    await drain();
    return booking;
  };
  const rowsOf = (userId: string) =>
    api.prisma.notification.findMany({
      where: { recipientUserId: userId, channel: 'EMAIL', eventCode: 'BOOKING_CANCELLED' },
      orderBy: { createdAt: 'asc' },
    });

  beforeAll(async () => {
    api = await createApiApp();
    service = api.app.get(NotificationsService);
    mail = api.app.get<EmailProvider>(EMAIL_PROVIDER) as InMemoryEmailProvider;
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await ensureFee(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    const body = {
      title: 'Booking {{bookingId}} cancelled',
      body: 'Your booking {{bookingId}} was cancelled.',
    };
    // A long-lived test database may still hold the template of an earlier run: re-activate it instead of failing on the duplicate.
    const existing = await api.prisma.notificationTemplate.findFirst({
      where: { eventCode: 'BOOKING_CANCELLED', channel: 'EMAIL', language: 'en' },
    });
    if (existing) {
      await api.prisma.notificationTemplate.update({
        where: { id: existing.id },
        data: { ...body, isActive: true },
      });
    } else {
      await as(api, admin)
        .post(T, { eventCode: 'BOOKING_CANCELLED', channel: 'EMAIL', ...body })
        .expect(201);
    }
  });
  afterAll(async () => {
    await api.prisma.notificationTemplate.updateMany({
      where: { channel: 'EMAIL' },
      data: { isActive: false },
    });
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('uses the in-memory adapter in tests and accepts EMAIL as a template channel', () => {
    expect(mail).toBeInstanceOf(InMemoryEmailProvider);
  });

  it('sends the rendered subject and body to the customer e-mail, once, and not to a user without an address', async () => {
    const { session, email } = await customerWithEmail();
    const booking = await cancelledBooking(session);
    const [row] = await rowsOf(session.userId);
    expect(row.status).toBe('QUEUED');
    expect(await service.deliver(row.id)).toBe('SENT');
    expect(await service.deliver(row.id)).toBe('ALREADY_DONE');
    const sent = mail.sent.filter((m) => m.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      subject: `Booking ${booking.id} cancelled`,
      body: `Your booking ${booking.id} was cancelled.`,
    });
    // the worker has no e-mail address on file: skipped, nothing sent
    const workerRows = await rowsOf(booking.worker.userId);
    expect(workerRows).toHaveLength(1);
    expect(await service.deliver(workerRows[0].id)).toBe('SKIPPED');
    expect((await rowsOf(booking.worker.userId))[0].lastError).toBe('NO_EMAIL');
  });

  it('respects the per-user preference: opted out means skipped, and the preference endpoint validates and is private', async () => {
    const { session } = await customerWithEmail();
    expect((await as(api, session).get(PREFS).expect(200)).body).toEqual({ email: true });
    expect((await as(api, session).put(PREFS, { email: 'no' })).status).toBe(400);
    expect((await as(api, session).put(PREFS, {})).status).toBe(400);
    expect((await api.http().get(PREFS)).status).toBe(401);
    expect((await as(api, session).put(PREFS, { email: false }).expect(200)).body).toEqual({
      email: false,
    });
    expect((await as(api, session).get(PREFS).expect(200)).body).toEqual({ email: false });

    const before = mail.sent.length;
    await cancelledBooking(session);
    const [row] = await rowsOf(session.userId);
    expect(await service.deliver(row.id)).toBe('SKIPPED');
    expect((await rowsOf(session.userId))[0].lastError).toBe('EMAIL_OPT_OUT');
    expect(mail.sent).toHaveLength(before);

    await as(api, session).put(PREFS, { email: true }).expect(200);
    await cancelledBooking(session);
    const rows = await rowsOf(session.userId);
    expect(await service.deliver(rows[1].id)).toBe('SENT');
  });

  it('a provider outage never rolls back the business change: the booking is cancelled, delivery retries then fails', async () => {
    const { session } = await customerWithEmail();
    mail.failWith = new ProviderError('brevo', 'brevo answered HTTP 503', true);
    try {
      const booking = await cancelledBooking(session); // cancel + dispatch succeed regardless
      const status = (await as(api, session).get(`/api/v1/bookings/${booking.id}`)).body.status;
      expect(status).toBe('CANCELLED');
      const [row] = await rowsOf(session.userId);
      await expect(service.deliver(row.id, { number: 1, max: 3 })).rejects.toThrow();
      expect(await service.deliver(row.id, { number: 3, max: 3 })).toBe('FAILED');
      mail.failWith = new ProviderError('brevo', 'rejected', false);
      const second = await cancelledBooking(session);
      expect(second.id).not.toBe(booking.id);
      const rows = await rowsOf(session.userId);
      expect(await service.deliver(rows[1].id, { number: 1, max: 3 })).toBe('FAILED');
    } finally {
      mail.failWith = null;
    }
  });
});
