import '../support/env-api-integration';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginWithOtp,
  otpKeyId,
  unique,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { as, createArea, onboardWorker, setRequiredChecks } from '../support/workforce';
import { InMemoryPushProvider } from '../../src/integrations/notifications/messaging-providers';
import { PUSH_PROVIDER } from '../../src/integrations/notifications/notification-providers.interface';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { TICKET_EVENT_TYPES } from '../../src/modules/support/dto/support.dto';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const API = '/api/v1';
const A = `${API}/admin`;

/**
 * Module 10 (support, safety, notifications, push) against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP
 * API, with the in-memory push adapter. Nothing here talks to Firebase.
 */
describe('Module 10: support, safety, notifications and push (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let categoryId: string;
  let push: InMemoryPushProvider;
  let notifications: NotificationsService;

  const drain = async () => {
    for (let i = 0; i < 100; i++) if ((await notifications.dispatchOutbox()).events === 0) return;
  };
  const raise = (body: object = {}, caller: { accessToken: string } = customer) =>
    as(api, caller).post(`${API}/support/tickets`, {
      categoryId,
      description: 'The worker did not arrive today',
      ...body,
    });
  const withKey = (caller: { accessToken: string }, url: string, key: string, body: object) =>
    api
      .http()
      .post(url)
      .set('Authorization', bearer(caller))
      .set('Idempotency-Key', key)
      .send(body);

  beforeAll(async () => {
    api = await createApiApp();
    push = api.app.get<InMemoryPushProvider>(PUSH_PROVIDER);
    notifications = api.app.get(NotificationsService);
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    categoryId = (
      await as(api, admin)
        .post(`${A}/support/categories`, {
          code: `M10_${unique().toUpperCase()}`,
          name: 'Module 10',
        })
        .expect(201)
    ).body.id as string;
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('app config support contact', () => {
    it('answers null for both values while nothing is configured', async () => {
      const res = await api.http().get(`${API}/app-config`).expect(200);
      expect(res.body.support).toEqual({ phone: null, email: null });
    });
  });

  describe('support tickets', () => {
    it('accepts a description of 10 to 4000 characters and refuses shorter or longer', async () => {
      expect((await raise({ description: '123456789' })).status).toBe(400);
      expect((await raise({ description: '   123456789   ' })).status).toBe(400); // trimmed first
      expect((await raise({ description: '1234567890' })).status).toBe(201);
      expect((await raise({ description: 'x'.repeat(4000) })).status).toBe(201);
      expect((await raise({ description: 'x'.repeat(4001) })).status).toBe(400);
    });

    it('keeps the description on the ticket, not in the conversation, and orders messages oldest first', async () => {
      const created = await raise({ subject: 'No show' }).expect(201);
      const id = created.body.id as string;
      expect(created.body).toMatchObject({
        subject: 'No show',
        description: 'The worker did not arrive today',
        status: 'OPEN',
        resolution: null,
      });
      expect(
        (await as(api, customer).get(`${API}/support/tickets/${id}/messages`).expect(200)).body
          .data,
      ).toHaveLength(0);

      for (const body of ['first', 'second', 'third']) {
        await as(api, customer).post(`${API}/support/tickets/${id}/messages`, { body }).expect(201);
      }
      // Same instant for all three: only the id tie-breaker can keep the order stable.
      await api.prisma.$executeRaw`ALTER TABLE support_messages DISABLE TRIGGER USER`;
      try {
        await api.prisma
          .$executeRaw`UPDATE support_messages SET created_at = '2026-01-01T00:00:00Z' WHERE ticket_id = ${id}::uuid`;
      } finally {
        await api.prisma.$executeRaw`ALTER TABLE support_messages ENABLE TRIGGER USER`;
      }
      const list = (
        await as(api, customer).get(`${API}/support/tickets/${id}/messages`).expect(200)
      ).body.data as Array<{ id: string; body: string }>;
      expect(list.map((m) => m.body)).toEqual(['first', 'second', 'third']);
      expect(list.map((m) => m.id)).toEqual([...list.map((m) => m.id)].sort());
    });

    it('publishes a closed set of history types and never shows staff notes, priority or staff identity to the customer', async () => {
      const id = (await raise().expect(201)).body.id as string;
      const t = `${A}/support/tickets/${id}`;
      await as(api, admin).post(`${t}/assign`, { note: 'INTERNAL-ASSIGN-NOTE' }).expect(200);
      await as(api, admin).post(`${t}/priority`, { priority: 'HIGH' }).expect(200);
      await as(api, admin)
        .post(`${t}/escalate`, { reason: 'INTERNAL-ESCALATE-REASON' })
        .expect(200);
      await as(api, admin)
        .post(`${t}/messages`, { body: 'INTERNAL-STAFF-NOTE', internal: true })
        .expect(201);
      await as(api, admin).post(`${t}/messages`, { body: 'We are looking into it' }).expect(201);

      const mine = await as(api, customer).get(`${API}/support/tickets/${id}`).expect(200);
      expect(mine.body.status).toBe('ESCALATED');
      expect(mine.body.history.map((h: { type: string }) => h.type)).toEqual([
        'CREATED',
        'ASSIGNED',
        'PRIORITY_SET',
        'ESCALATED',
      ]);
      for (const h of mine.body.history as Array<Record<string, unknown>>) {
        expect(TICKET_EVENT_TYPES).toContain(h.type);
        expect(Object.keys(h).sort()).toEqual(['createdAt', 'fromStatus', 'toStatus', 'type']);
      }
      const messages = await as(api, customer)
        .get(`${API}/support/tickets/${id}/messages`)
        .expect(200);
      expect(JSON.stringify([mine.body, messages.body])).not.toMatch(/INTERNAL-/);
      expect(messages.body.data.map((m: { body: string }) => m.body)).toEqual([
        'We are looking into it',
      ]);
      expect(mine.body).not.toHaveProperty('priority');

      // CLOSED is final: no more messages, and the customer sees the resolution written for them.
      await as(api, admin).post(`${t}/close`, { resolution: 'Refund agreed' }).expect(200);
      const closed = await as(api, customer).get(`${API}/support/tickets/${id}`).expect(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', resolution: 'Refund agreed' });
      expect(closed.body.history.at(-1).type).toBe('CLOSED');
      const refused = await as(api, customer).post(`${API}/support/tickets/${id}/messages`, {
        body: 'hello again',
      });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('TICKET_CLOSED');
      expect((await as(api, admin).post(`${t}/assign`, {})).body.code).toBe('TICKET_CLOSED'); // no reopening through any staff action
    });

    it('links payment, replacement and interview problems through the booking the caller is a party to', async () => {
      const own = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      expect((await raise({ bookingId: own.id })).body.bookingId).toBe(own.id);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const res = await raise({ bookingId: own.id }, stranger);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BOOKING_NOT_FOUND');
      // An id that is not a booking (a payment or interview id) is not accepted as one.
      expect((await raise({ bookingId: UNKNOWN_ID })).status).toBe(404);
    });
  });

  describe('safety reports', () => {
    it("refuses a worker that is not the one on the booking, and a booking that is not the caller's", async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const other = await onboardWorker(api, { areaIds: [area.id] });
      const mismatch = await as(api, customer).post(`${API}/safety/reports`, {
        reasonCode: 'MISCONDUCT',
        bookingId: booking.id,
        workerId: other.workerId,
      });
      expect(mismatch.status).toBe(404);
      expect(mismatch.body.code).toBe('SAFETY_TARGET_NOT_FOUND');
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect(
        (
          await as(api, stranger).post(`${API}/safety/reports`, {
            reasonCode: 'MISCONDUCT',
            bookingId: booking.id,
          })
        ).status,
      ).toBe(404);
      const none = await as(api, customer).post(`${API}/safety/reports`, { reasonCode: 'OTHER' });
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('SAFETY_TARGET_REQUIRED');
      const badCode = await as(api, customer).post(`${API}/safety/reports`, {
        reasonCode: 'ARRIVED_LATE',
        bookingId: booking.id,
      });
      expect(badCode.status).toBe(400);
      expect(
        await api.prisma.safetyReport.count({ where: { reporterUserId: customer.userId } }),
      ).toBe(0);
    });

    it('files one report per Idempotency-Key, also under concurrent retries, and returns the report id', async () => {
      const booking = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const key = `m10-${unique()}`;
      const body = {
        reasonCode: 'SAFETY_CONCERN',
        bookingId: booking.id,
        workerId: booking.worker.workerId,
        note: 'what happened',
        reason: 'does not feel safe',
        alsoBlock: true,
      };
      const url = `${API}/safety/reports`;
      const results = await Promise.all([1, 2, 3, 4].map(() => withKey(customer, url, key, body)));
      const created = results.filter((r) => r.status === 201 && !r.headers['idempotent-replay']);
      expect(created).toHaveLength(1);
      for (const r of results) {
        expect([201, 409]).toContain(r.status); // 409 = still in flight; the client retries
      }
      const replay = await withKey(customer, url, key, body);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body.id).toBe(created[0].body.id);
      expect(Object.keys(replay.body as object).sort()).toEqual(['createdAt', 'id', 'reasonCode']);
      expect(await api.prisma.safetyReport.count({ where: { id: String(replay.body.id) } })).toBe(
        1,
      );
      expect(
        await api.prisma.safetyReport.count({ where: { reporterUserId: customer.userId } }),
      ).toBe(1);

      // The same key with a different request is refused, not silently replayed.
      const reused = await withKey(customer, url, key, { ...body, reasonCode: 'THEFT' });
      expect(reused.status).toBe(422);

      // `reason` is kept with the block; `note` stays on the report for staff and out of the audit log.
      const block = await api.prisma.userBlock.findFirstOrThrow({
        where: { blockerUserId: customer.userId },
      });
      expect(block.reason).toBe('does not feel safe');
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { entityId: replay.body.id as string, action: 'safety.report' },
      });
      expect(JSON.stringify(audit.metadata)).not.toContain('what happened');

      // The blocked-workers list shows the worker reference and nothing else about them.
      const blocked = await as(api, customer).get(`${API}/safety/blocks`).expect(200);
      expect(blocked.body).toHaveLength(1);
      expect(Object.keys(blocked.body[0] as object).sort()).toEqual([
        'createdAt',
        'id',
        'workerId',
      ]);
      expect(blocked.body[0].workerId).toBe(booking.worker.workerId);
    });

    it('does not show reports to other customers or to staff without support.view', async () => {
      const other = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, other).get(`${A}/safety/reports`)).status).toBe(403);
      expect((await api.http().post(`${API}/safety/reports`).send({})).status).toBe(401);
    });
  });

  describe('unread count and inbox actions', () => {
    let notificationId: string;
    let ticketId: string;

    it('reports {count, unread} for the signed-in user only', async () => {
      const fresh = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect(
        (await as(api, fresh).get(`${API}/notifications/unread-count`).expect(200)).body,
      ).toEqual({
        count: 0,
        unread: 0,
      });
      // An IN_APP template for ticket updates, then a staff action that notifies the customer.
      // Active IN_APP and PUSH wording for ticket updates (kept if a previous run already created it).
      for (const channel of ['IN_APP', 'PUSH'] as const) {
        const data = { title: 'Ticket', body: 'Ticket {{ticketId}} is {{status}}', isActive: true };
        await api.prisma.notificationTemplate.upsert({
          where: {
            eventCode_channel_language: { eventCode: 'TICKET_UPDATE', channel, language: 'en' },
          },
          create: { eventCode: 'TICKET_UPDATE', channel, language: 'en', ...data },
          update: data,
        });
      }
      await drain(); // events raised before the templates existed are expanded now
      const otherCount = (await as(api, customer).get(`${API}/notifications/unread-count`)).body
        .count as number;
      ticketId = (await raise({}, fresh).expect(201)).body.id as string;
      await as(api, admin).post(`${A}/support/tickets/${ticketId}/assign`, {}).expect(200);
      await drain();

      const mine = await as(api, fresh).get(`${API}/notifications/unread-count`).expect(200);
      expect(mine.body).toEqual({ count: 1, unread: 1 });
      expect((await as(api, customer).get(`${API}/notifications/unread-count`)).body.count).toBe(
        otherCount,
      ); // someone else's notifications are not counted
      const item = (await as(api, fresh).get(`${API}/notifications`).expect(200)).body.data[0];
      expect(item.route).toEqual({ type: 'ticket', id: ticketId });
      notificationId = item.id as string;

      // read -> unread -> read, owner only, repeating is harmless
      await as(api, fresh).post(`${API}/notifications/${notificationId}/read`).expect(204);
      expect((await as(api, fresh).get(`${API}/notifications/unread-count`)).body.count).toBe(0);
      await as(api, fresh).post(`${API}/notifications/${notificationId}/unread`).expect(204);
      await as(api, fresh).post(`${API}/notifications/${notificationId}/unread`).expect(204);
      expect((await as(api, fresh).get(`${API}/notifications/unread-count`)).body.count).toBe(1);
      const stranger = await as(api, customer).post(
        `${API}/notifications/${notificationId}/unread`,
      );
      expect(stranger.status).toBe(404);
      expect((await as(api, fresh).post(`${API}/notifications/${UNKNOWN_ID}/unread`)).status).toBe(
        404,
      );
      expect((await api.http().post(`${API}/notifications/${notificationId}/unread`)).status).toBe(
        401,
      );
    });

    it('sends the push with route keys as strings and without personal data', async () => {
      const owner = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const token = `fcm-${unique()}`;
      await as(api, owner)
        .put(`${API}/auth/device-token`, { token, platform: 'ANDROID' })
        .expect(204);
      const id = (await raise({}, owner).expect(201)).body.id as string;
      await as(api, admin).post(`${A}/support/tickets/${id}/assign`, {}).expect(200);
      await drain();
      const row = await api.prisma.notification.findFirstOrThrow({
        where: { recipientUserId: owner.userId, channel: 'PUSH' },
      });
      expect(await notifications.deliver(row.id)).toBe('SENT');
      const sent = push.sent.filter((m) => m.to === token);
      expect(sent).toHaveLength(1);
      expect(sent[0].data).toEqual({
        notificationId: row.id,
        event: 'TICKET_UPDATE',
        routeType: 'ticket',
        routeId: id,
      });
      for (const value of Object.values(sent[0].data!)) expect(typeof value).toBe('string');
    });
  });

  describe('device tokens', () => {
    /** A second signed-in device of the same person (the OTP resend cooldown is a test concern, so it is cleared). */
    const secondDevice = async (first: { mobile?: string }) => {
      await api.redis.client.del(`auth:otp:cooldown:${otpKeyId(first.mobile ?? '')}`);
      return loginWithOtp(api, { appType: 'CUSTOMER', mobile: first.mobile });
    };
    const bind = (caller: { accessToken: string }, token: string) =>
      as(api, caller).put(`${API}/auth/device-token`, { token, platform: 'ANDROID' });
    const tokensOf = async (userId: string) =>
      (await api.prisma.deviceToken.findMany({ where: { userId }, select: { token: true } })).map(
        (t) => t.token,
      );

    it('binds one token per session, keeps several devices, and logout drops only its own', async () => {
      const phone = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const tablet = await secondDevice(phone);
      expect(tablet.userId).toBe(phone.userId);
      const [a, b] = [`fcm-a-${unique()}`, `fcm-b-${unique()}`];
      await bind(phone, a).expect(204);
      await bind(tablet, b).expect(204);
      expect((await tokensOf(phone.userId)).sort()).toEqual([a, b].sort());

      await as(api, phone).post(`${API}/auth/logout`).expect(204);
      expect(await tokensOf(phone.userId)).toEqual([b]);
    });

    it('unbinds the current session only, repeatedly, and never touches another user', async () => {
      const mine = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const theirs = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const [a, b] = [`fcm-m-${unique()}`, `fcm-t-${unique()}`];
      await bind(mine, a).expect(204);
      await bind(theirs, b).expect(204);
      await as(api, mine).delete(`${API}/auth/device-token`).expect(204);
      await as(api, mine).delete(`${API}/auth/device-token`).expect(204);
      expect(await tokensOf(mine.userId)).toEqual([]);
      expect(await tokensOf(theirs.userId)).toEqual([b]);
      // the session itself is still valid
      await as(api, mine).get(`${API}/auth/sessions`).expect(200);
      expect((await api.http().delete(`${API}/auth/device-token`)).status).toBe(401);
    });

    it('removes a token the provider reports dead, still delivers to the live device, and skips when none is left', async () => {
      const phone = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const tablet = await secondDevice(phone);
      const [dead, live] = [`fcm-dead-${unique()}`, `fcm-live-${unique()}`];
      await bind(phone, dead).expect(204);
      await bind(tablet, live).expect(204);
      push.invalidTokens.add(dead);

      const make = async () => {
        const id = (await raise({}, phone).expect(201)).body.id as string;
        await as(api, admin)
          .post(`${A}/support/tickets/${id}/escalate`, { reason: 'check' })
          .expect(200);
        await drain();
        return api.prisma.notification.findFirstOrThrow({
          where: { recipientUserId: phone.userId, channel: 'PUSH', status: 'QUEUED' },
          orderBy: { createdAt: 'desc' },
        });
      };

      const first = await make();
      expect(await notifications.deliver(first.id)).toBe('SENT');
      expect(await tokensOf(phone.userId)).toEqual([live]); // the dead binding is gone
      expect(push.sent.some((m) => m.to === live)).toBe(true);
      expect(push.sent.some((m) => m.to === dead)).toBe(false);

      push.invalidTokens.add(live);
      const second = await make();
      expect(await notifications.deliver(second.id)).toBe('SKIPPED');
      expect(await tokensOf(phone.userId)).toEqual([]);
      expect(
        await api.prisma.notification.findUniqueOrThrow({ where: { id: second.id } }),
      ).toMatchObject({ status: 'SKIPPED', lastError: 'NO_VALID_DEVICE' });
      const log = await as(api, admin)
        .get(`${A}/notifications?recipientUserId=${phone.userId}`)
        .expect(200);
      expect(JSON.stringify(log.body)).not.toContain('fcm-');
    });
  });
});
