import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { ensureFee, inDays } from '../support/bookings';
import {
  approveCheck,
  as,
  createArea,
  OnboardedWorker,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const B = '/api/v1/bookings';
const I = '/api/v1/interviews';
const W = '/api/v1/workers/me/interviews';
const A = '/api/v1/admin';
const UNKNOWN = '00000000-0000-7000-8000-000000000000';

type Session = Awaited<ReturnType<typeof loginWithOtp>>;

const at = (days: number, hour = 10): string => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

/**
 * The dedicated interview / trial workflow (PRD 5.4, 6.3, 12): request, worker answer, proposal, reschedule, cancel, outcome, and the
 * way the booking state follows it.
 */
describe('Interview and trial workflow (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let area: { id: string; name: string; city: string };

  const customer = async (): Promise<Session> => {
    const session = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, session)
      .post('/api/v1/customers/me', {
        name: 'Asha Rao',
        email: `c.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    return session;
  };
  const worker = async (): Promise<OnboardedWorker> => {
    const w = await onboardWorker(api, {
      areaIds: [area.id],
      engagement: 'HOURLY',
      windows: [{ start: '06:00', end: '22:00' }],
    });
    await approveCheck(api, admin, w, 'IDENTITY');
    return w;
  };
  /** A booking matched to a verified worker: the starting point of an interview request. */
  const matched = async () => {
    const c = await customer();
    const w = await worker();
    const created = await as(api, c)
      .post(B, {
        category: 'HOUSE_MAID',
        areaId: area.id,
        engagement: 'HOURLY',
        availableFrom: '09:00',
        availableTo: '10:00',
        startDate: inDays(3),
        workerId: w.workerId,
      })
      .expect(201);
    return { c, w, bookingId: created.body.id as string };
  };
  const request = (c: Session, bookingId: string, body: object = {}) =>
    as(api, c).post(I, {
      bookingId,
      type: 'INTERVIEW',
      preferredAt: at(2),
      ...body,
    });
  const status = async (c: Session, bookingId: string): Promise<string> =>
    (await as(api, c).get(`${B}/${bookingId}`)).body.status as string;
  const row = (id: string) => api.prisma.interviewTrial.findUniqueOrThrow({ where: { id } });
  const events = async (bookingId: string): Promise<string[]> =>
    (
      await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'bookingId'], equals: bookingId } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((e) => (e.payload as { event: string }).event);

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY']);
    await ensureFee(api, admin);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('the full journey: interview, then trial, then confirmation', () => {
    it('request -> accept -> complete, a second round as a trial, then the worker can be confirmed', async () => {
      const { c, w, bookingId } = await matched();
      const preferred = at(2);
      const req = await request(c, bookingId, { preferredAt: preferred, note: 'Please bring ID' });
      expect(req.status).toBe(201);
      expect(req.body).toMatchObject({
        bookingId,
        type: 'INTERVIEW',
        status: 'REQUESTED',
        statusLabel: 'Waiting for worker',
        requestedBy: 'CUSTOMER',
        note: 'Please bring ID',
        scheduledAt: null,
      });
      expect(req.body.preferredAt).toBe(preferred);
      const id = req.body.id as string;
      expect(await status(c, bookingId)).toBe('MATCHED'); // nothing agreed yet

      const feed = await as(api, w).get(W);
      expect(feed.status).toBe(200);
      expect(
        (feed.body.data as Array<{ id: string; status: string }>).map((x) => [x.id, x.status]),
      ).toEqual([[id, 'REQUESTED']]);
      expect(JSON.stringify(feed.body)).not.toContain(c.userId);

      const accepted = await as(api, w).post(`${W}/${id}/accept`);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ status: 'CONFIRMED', statusLabel: 'Confirmed' });
      expect(accepted.body.scheduledAt).toBe(preferred);
      const booking = (await as(api, c).get(`${B}/${bookingId}`)).body;
      expect(booking.status).toBe('INTERVIEW_TRIAL_SCHEDULED');
      expect(booking.scheduleType).toBe('INTERVIEW');
      expect(booking.scheduledAt).toBe(preferred);
      expect(booking.workerRespondedAt).not.toBeNull();
      // repeating the accept changes nothing
      expect((await as(api, w).post(`${W}/${id}/accept`)).status).toBe(200);

      const done = await as(api, c).post(`${I}/${id}/complete`, { outcomeNote: 'Good fit' });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'COMPLETED', outcomeNote: 'Good fit' });
      expect(done.body.completedAt).not.toBeNull();
      expect(await status(c, bookingId)).toBe('INTERVIEW_TRIAL_COMPLETED');

      // a further round: a trial
      const trial = await request(c, bookingId, { type: 'TRIAL', preferredAt: at(4) });
      expect(trial.status).toBe(201);
      await as(api, w).post(`${W}/${trial.body.id}/accept`).expect(200);
      expect(await status(c, bookingId)).toBe('INTERVIEW_TRIAL_SCHEDULED');
      expect((await as(api, c).get(`${B}/${bookingId}`)).body.scheduleType).toBe('TRIAL');
      await as(api, c)
        .post(`${I}/${trial.body.id}/complete`, { outcomeNote: 'Trial went well' })
        .expect(200);

      // the booking carries on as before
      const confirmed = await as(api, c).post(`${B}/${bookingId}/confirm-worker`, {
        startDate: inDays(3),
      });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.status).toBe('PENDING_PAYMENT');

      const list = await as(api, c).get(`${B}/${bookingId}/interviews`);
      expect(list.body.map((x: { type: string; status: string }) => [x.type, x.status])).toEqual([
        ['INTERVIEW', 'COMPLETED'],
        ['TRIAL', 'COMPLETED'],
      ]);
      const timeline = (await as(api, c).get(`${B}/${bookingId}`)).body.timeline.map(
        (t: { note: string | null }) => t.note,
      );
      expect(timeline).toEqual(
        expect.arrayContaining(['interview requested', 'interview scheduled', 'trial scheduled']),
      );
      const seen = await events(bookingId);
      expect(seen).toEqual(
        expect.arrayContaining([
          'INTERVIEW_REQUESTED',
          'INTERVIEW_TRIAL_SCHEDULED',
          'INTERVIEW_OUTCOME',
        ]),
      );
      const audits = await api.prisma.auditLog.findMany({
        where: { entityId: id, entityType: 'interview_trial' },
      });
      expect(audits.map((a) => a.action).sort()).toEqual([
        'interview.accept',
        'interview.complete',
        'interview.request',
      ]);
      // the worker no longer sees an open request, but keeps the history
      expect(((await as(api, w).get(`${W}?status=COMPLETED`)).body.data as unknown[]).length).toBe(
        2,
      );
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('worker answers', () => {
    it('declines with a reason; the booking stays matched and the customer can ask again', async () => {
      const { c, w, bookingId } = await matched();
      const id = (await request(c, bookingId)).body.id as string;
      expect((await as(api, w).post(`${W}/${id}/decline`, {})).status).toBe(400);
      const declined = await as(api, w).post(`${W}/${id}/decline`, {
        reason: 'Not available that week',
      });
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({
        status: 'DECLINED',
        declineReason: 'Not available that week',
      });
      expect(await status(c, bookingId)).toBe('MATCHED');
      expect((await as(api, w).post(`${W}/${id}/accept`)).status).toBe(409); // closed
      expect(await events(bookingId)).toContain('INTERVIEW_RESPONDED');
      expect((await request(c, bookingId, { preferredAt: at(5) })).status).toBe(201);
    });

    it('proposes another time: the customer accepts it, or keeps the original', async () => {
      const { c, w, bookingId } = await matched();
      const preferred = at(2);
      const id = (await request(c, bookingId, { preferredAt: preferred })).body.id as string;
      const other = at(2, 14);
      const proposed = await as(api, w).post(`${W}/${id}/propose`, {
        proposedAt: other,
        note: 'Afternoon is better',
      });
      expect(proposed.status).toBe(200);
      expect(proposed.body).toMatchObject({ status: 'RESCHEDULE_PROPOSED', proposedBy: 'WORKER' });
      expect(proposed.body.proposedAt).toBe(other);
      expect(await status(c, bookingId)).toBe('MATCHED');
      // the same proposal again changes nothing
      expect((await as(api, w).post(`${W}/${id}/propose`, { proposedAt: other })).status).toBe(200);
      // the customer keeps the original: back to REQUESTED, the worker can accept it
      const kept = await as(api, c).post(`${I}/${id}/reject-proposal`);
      expect(kept.body).toMatchObject({ status: 'REQUESTED', proposedAt: null });
      await as(api, w).post(`${W}/${id}/propose`, { proposedAt: other }).expect(200);
      const accepted = await as(api, c).post(`${I}/${id}/accept-proposal`);
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ status: 'CONFIRMED', proposedAt: null });
      expect(accepted.body.scheduledAt).toBe(other);
      const booking = (await as(api, c).get(`${B}/${bookingId}`)).body;
      expect(booking.status).toBe('INTERVIEW_TRIAL_SCHEDULED');
      expect(booking.scheduledAt).toBe(other);

      // a worker can also ask to move a confirmed time; rejecting keeps the agreed time
      const later = at(3, 9);
      await as(api, w).post(`${W}/${id}/propose`, { proposedAt: later }).expect(200);
      const stay = await as(api, c).post(`${I}/${id}/reject-proposal`);
      expect(stay.body.status).toBe('CONFIRMED');
      expect(stay.body.scheduledAt).toBe(other);
      expect((await as(api, c).get(`${B}/${bookingId}`)).body.scheduledAt).toBe(other);
    });

    it('refuses proposals for the time already requested, in the past, or from the wrong party', async () => {
      const { c, w, bookingId } = await matched();
      const preferred = at(2);
      const id = (await request(c, bookingId, { preferredAt: preferred })).body.id as string;
      for (const bad of [
        { proposedAt: preferred },
        { proposedAt: new Date(Date.now() - 3_600_000).toISOString() },
        { proposedAt: 'soon' },
        {},
      ]) {
        expect((await as(api, w).post(`${W}/${id}/propose`, bad)).status).toBe(400);
      }
      expect((await as(api, c).post(`${I}/${id}/propose`, { proposedAt: at(3) })).status).toBe(404); // no such customer route
      expect((await as(api, c).post(`${I}/${id}/accept-proposal`)).status).toBe(409); // nothing proposed
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('customer changes the plan', () => {
    it('reschedules: the booking goes back to matched until the worker answers again', async () => {
      const { c, w, bookingId } = await matched();
      const id = (await request(c, bookingId)).body.id as string;
      await as(api, w).post(`${W}/${id}/accept`).expect(200);
      expect(await status(c, bookingId)).toBe('INTERVIEW_TRIAL_SCHEDULED');
      const moved = at(5);
      const res = await as(api, c).post(`${I}/${id}/reschedule`, { preferredAt: moved });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'REQUESTED', scheduledAt: null });
      expect(res.body.preferredAt).toBe(moved);
      const booking = (await as(api, c).get(`${B}/${bookingId}`)).body;
      expect(booking).toMatchObject({ status: 'MATCHED', scheduleType: null, scheduledAt: null });
      await as(api, w).post(`${W}/${id}/accept`).expect(200);
      expect((await as(api, c).get(`${B}/${bookingId}`)).body.scheduledAt).toBe(moved);
      expect(
        (
          await as(api, c).post(`${I}/${id}/reschedule`, {
            preferredAt: new Date(Date.now() - 1000).toISOString(),
          })
        ).status,
      ).toBe(400);
    });

    it('cancels (customer, worker or staff): the booking returns to matched, the other side is told, a reason is required', async () => {
      for (const who of ['customer', 'worker', 'admin'] as const) {
        const { c, w, bookingId } = await matched();
        const id = (await request(c, bookingId)).body.id as string;
        await as(api, w).post(`${W}/${id}/accept`).expect(200);
        const caller =
          who === 'customer' ? as(api, c) : who === 'worker' ? as(api, w) : as(api, admin);
        const url =
          who === 'customer'
            ? `${I}/${id}/cancel`
            : who === 'worker'
              ? `${W}/${id}/cancel`
              : `${A}/interviews/${id}/cancel`;
        expect((await caller.post(url, {})).status).toBe(400);
        const res = await caller.post(url, { reason: 'Something came up' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Something came up' });
        expect(res.body.cancelledAt).not.toBeNull();
        expect(await status(c, bookingId)).toBe('MATCHED');
        expect(await events(bookingId)).toContain('INTERVIEW_CANCELLED');
        expect((await caller.post(url, { reason: 'again' })).status).toBe(409);
        // a new request is possible again
        expect((await request(c, bookingId, { preferredAt: at(6) })).status).toBe(201);
      }
    });

    it('cancelling the booking, or the worker declining the job, closes the open interview', async () => {
      const a = await matched();
      const idA = (await request(a.c, a.bookingId)).body.id as string;
      await as(api, a.c)
        .post(`${B}/${a.bookingId}/cancel`, { reason: 'No longer needed' })
        .expect(200);
      expect((await row(idA)).status).toBe('CANCELLED');
      expect((await as(api, a.w).post(`${W}/${idA}/accept`)).status).toBe(409);

      const b = await matched();
      const idB = (await request(b.c, b.bookingId)).body.id as string;
      await as(api, b.w)
        .post(`/api/v1/workers/me/bookings/${b.bookingId}/decline`, {
          reason: 'Cannot take the job',
        })
        .expect(200);
      expect((await row(idB)).status).toBe('CANCELLED');
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('rules and conflicts', () => {
    it('allows one open interview per booking, also when requests arrive at the same moment', async () => {
      const { c, bookingId } = await matched();
      const results = await Promise.all([1, 2, 3, 4].map(() => request(c, bookingId)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409))
        expect(r.body.code).toBe('INTERVIEW_ALREADY_OPEN');
      expect(await api.prisma.interviewTrial.count({ where: { bookingId } })).toBe(1);
    });

    it('is idempotent with an Idempotency-Key', async () => {
      const { c, bookingId } = await matched();
      const key = `iv-${unique()}`;
      const body = { type: 'INTERVIEW', preferredAt: at(2) };
      const first = await as(api, c)
        .post(I, { bookingId, ...body })
        .set('Idempotency-Key', key);
      const second = await as(api, c)
        .post(I, { bookingId, ...body })
        .set('Idempotency-Key', key);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(await api.prisma.interviewTrial.count({ where: { bookingId } })).toBe(1);
    });

    it('needs a matched worker and a booking in the right state', async () => {
      const c = await customer();
      const fresh = await as(api, c)
        .post(B, {
          category: 'HOUSE_MAID',
          areaId: area.id,
          engagement: 'HOURLY',
          availableFrom: '09:00',
          availableTo: '10:00',
        })
        .expect(201);
      expect(fresh.body.status).toBe('NEW_REQUEST');
      const noWorker = await request(c, fresh.body.id as string);
      expect(noWorker.status).toBe(409);
      expect(noWorker.body.code).toBe('INVALID_TRANSITION');

      const { c: c2, w, bookingId } = await matched();
      const id = (await request(c2, bookingId)).body.id as string;
      await as(api, w).post(`${W}/${id}/accept`).expect(200);
      await as(api, c2).post(`${I}/${id}/complete`, { outcomeNote: 'ok' }).expect(200);
      await as(api, c2)
        .post(`${B}/${bookingId}/confirm-worker`, { startDate: inDays(3) })
        .expect(200);
      const late = await request(c2, bookingId);
      expect(late.status).toBe(409); // PENDING_PAYMENT
      expect(late.body.code).toBe('INVALID_TRANSITION');
    });

    it('only completes a confirmed interview, needs an outcome, and refuses steps out of order', async () => {
      const { c, w, bookingId } = await matched();
      const id = (await request(c, bookingId)).body.id as string;
      const early = await as(api, c).post(`${I}/${id}/complete`, { outcomeNote: 'ok' });
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('INVALID_INTERVIEW_STATE');
      await as(api, w).post(`${W}/${id}/accept`).expect(200);
      expect((await as(api, c).post(`${I}/${id}/complete`, {})).status).toBe(400);
      expect((await as(api, c).post(`${I}/${id}/reject-proposal`)).status).toBe(409);
      await as(api, c).post(`${I}/${id}/complete`, { outcomeNote: 'ok' }).expect(200);
      expect((await as(api, c).post(`${I}/${id}/complete`, { outcomeNote: 'again' })).status).toBe(
        409,
      );
      expect((await as(api, c).post(`${I}/${id}/cancel`, { reason: 'late' })).status).toBe(409);
    });

    it('validates the request: type, time in the future, note length', async () => {
      const { c, bookingId } = await matched();
      for (const bad of [
        { type: 'CHAT' },
        { type: undefined },
        { preferredAt: 'tomorrow' },
        { preferredAt: new Date(Date.now() - 60_000).toISOString() },
        { note: 'x'.repeat(301) },
      ]) {
        const res = await request(c, bookingId, bad);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_FAILED');
      }
      expect(await api.prisma.interviewTrial.count({ where: { bookingId } })).toBe(0);
    });

    it('accept racing a cancellation leaves the session and the booking consistent', async () => {
      for (let i = 0; i < 3; i++) {
        const { c, w, bookingId } = await matched();
        const id = (await request(c, bookingId)).body.id as string;
        const [a, b] = await Promise.all([
          as(api, w).post(`${W}/${id}/accept`),
          as(api, c).post(`${I}/${id}/cancel`, { reason: 'changed my mind' }),
        ]);
        const s = (await row(id)).status;
        const bookingStatus = await status(c, bookingId);
        expect([a.status, b.status].every((x) => x === 200 || x === 409)).toBe(true);
        if (s === 'CONFIRMED') expect(bookingStatus).toBe('INTERVIEW_TRIAL_SCHEDULED');
        else {
          expect(s).toBe('CANCELLED');
          expect(bookingStatus).toBe('MATCHED');
        }
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('who can do what', () => {
    it('keeps other customers, other workers, and the wrong role out', async () => {
      const { c, w, bookingId } = await matched();
      const id = (await request(c, bookingId)).body.id as string;
      const stranger = await customer();
      const otherWorker = await worker();
      for (const call of [
        () => as(api, stranger).get(`${B}/${bookingId}/interviews`),
        () => as(api, stranger).get(`${I}/${id}`),
        () => as(api, stranger).post(`${I}/${id}/cancel`, { reason: 'x' }),
        () =>
          as(api, stranger).post(I, {
            bookingId,
            type: 'INTERVIEW',
            preferredAt: at(3),
          }),
        () => as(api, otherWorker).get(`${W}/${id}`),
        () => as(api, otherWorker).post(`${W}/${id}/accept`),
        () => as(api, otherWorker).post(`${W}/${id}/decline`, { reason: 'x' }),
        () => as(api, c).get(`${I}/${UNKNOWN}`),
        () => as(api, w).get(`${W}/${UNKNOWN}`),
      ]) {
        expect((await call()).status).toBe(404);
      }
      expect((await as(api, c).post(`${W}/${id}/accept`)).status).toBe(403);
      expect((await as(api, w).post(`${I}/${id}/complete`, { outcomeNote: 'x' })).status).toBe(403);
      expect(
        (
          await as(api, w).post(I, {
            bookingId,
            type: 'INTERVIEW',
            preferredAt: at(3),
          })
        ).status,
      ).toBe(403);
      expect((await as(api, c).get(`${A}/interviews`)).status).toBe(403);
      expect((await api.http().get(`${I}/${id}`)).status).toBe(401);
      expect((await api.http().get(W)).status).toBe(401);
      expect((await as(api, c).get(`${I}/not-a-uuid`)).status).toBe(400);
      // nothing changed
      expect((await row(id)).status).toBe('REQUESTED');
    });

    it('staff search, act on behalf of both sides, and need the right permission', async () => {
      const { c, w, bookingId } = await matched();
      const requested = await as(api, admin).post(`${A}/interviews`, {
        bookingId,
        type: 'TRIAL',
        preferredAt: at(2),
      });
      expect(requested.status).toBe(201);
      expect(requested.body.requestedBy).toBe('ADMIN');
      const id = requested.body.id as string;
      const found = await as(api, admin).get(
        `${A}/interviews?bookingId=${bookingId}&status=REQUESTED&type=TRIAL`,
      );
      expect((found.body.data as Array<{ id: string }>).map((x) => x.id)).toEqual([id]);
      expect((await as(api, admin).get(`${A}/bookings/${bookingId}/interviews`)).body).toHaveLength(
        1,
      );
      expect((await as(api, admin).get(`${A}/interviews/${id}`)).body.id).toBe(id);

      const confirmed = await as(api, admin).post(`${A}/interviews/${id}/confirm`);
      expect(confirmed.body.status).toBe('CONFIRMED');
      expect(await status(c, bookingId)).toBe('INTERVIEW_TRIAL_SCHEDULED');
      const done = await as(api, admin).post(`${A}/interviews/${id}/complete`, {
        outcomeNote: 'Recorded by staff',
      });
      expect(done.body.status).toBe('COMPLETED');
      expect(await status(c, bookingId)).toBe('INTERVIEW_TRIAL_COMPLETED');
      const audit = await api.prisma.auditLog.findMany({
        where: { entityId: id, actorId: admin.userId },
      });
      expect(audit.map((a) => a.action).sort()).toEqual([
        'interview.accept',
        'interview.complete',
        'interview.request',
      ]);
      expect((await as(api, admin).get(`${A}/interviews?status=NOPE`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}/interviews?bookingId=nope`)).status).toBe(400);

      const viewOnly = await loginAdminWithPermissions(api, ['booking.view']);
      expect((await as(api, viewOnly).get(`${A}/interviews`)).status).toBe(200);
      expect(
        (await as(api, viewOnly).post(`${A}/interviews/${id}/cancel`, { reason: 'x' })).status,
      ).toBe(403);
      expect(
        (
          await as(api, viewOnly).post(`${A}/interviews`, {
            bookingId,
            type: 'INTERVIEW',
            preferredAt: at(3),
          })
        ).status,
      ).toBe(403);
      void w;
    });
  });

  // ------------------------------------------------------------------------------------------------------------
  describe('the booking-level actions stay consistent with the interview entity', () => {
    it('schedule creates a confirmed session, interview-complete completes it, and a request is confirmed by schedule', async () => {
      const { c, bookingId } = await matched();
      const when = at(3);
      await as(api, c)
        .post(`${B}/${bookingId}/schedule`, { scheduleType: 'TRIAL', scheduledAt: when })
        .expect(200);
      const open = await as(api, c).get(`${B}/${bookingId}/interviews`);
      expect(open.body).toHaveLength(1);
      expect(open.body[0]).toMatchObject({
        type: 'TRIAL',
        status: 'CONFIRMED',
        requestedBy: 'CUSTOMER',
      });
      expect(open.body[0].scheduledAt).toBe(when);
      await as(api, c)
        .post(`${B}/${bookingId}/interview-complete`, { outcomeNote: 'Fine' })
        .expect(200);
      const done = (await as(api, c).get(`${B}/${bookingId}/interviews`)).body[0];
      expect(done).toMatchObject({ status: 'COMPLETED', outcomeNote: 'Fine' });

      const other = await matched();
      const requested = (await request(other.c, other.bookingId)).body.id as string;
      const when2 = at(4);
      await as(api, other.c)
        .post(`${B}/${other.bookingId}/schedule`, { scheduleType: 'INTERVIEW', scheduledAt: when2 })
        .expect(200);
      const same = await row(requested);
      expect(same.status).toBe('CONFIRMED');
      expect(same.scheduledAt?.toISOString()).toBe(when2);
      expect(await api.prisma.interviewTrial.count({ where: { bookingId: other.bookingId } })).toBe(
        1,
      );
    });

    it('the older slot proposal is mirrored on the session', async () => {
      const { c, w, bookingId } = await matched();
      const when = at(3);
      await as(api, c)
        .post(`${B}/${bookingId}/schedule`, { scheduleType: 'INTERVIEW', scheduledAt: when })
        .expect(200);
      const proposed = at(3, 15);
      await as(api, w)
        .put(`/api/v1/workers/me/bookings/${bookingId}/slot-proposal`, { proposedAt: proposed })
        .expect(200);
      const mid = (await as(api, c).get(`${B}/${bookingId}/interviews`)).body[0];
      expect(mid).toMatchObject({ status: 'RESCHEDULE_PROPOSED' });
      expect(mid.proposedAt).toBe(proposed);
      await as(api, c).post(`${B}/${bookingId}/slot-proposal/accept`).expect(200);
      const end = (await as(api, c).get(`${B}/${bookingId}/interviews`)).body[0];
      expect(end).toMatchObject({ status: 'CONFIRMED', proposedAt: null });
      expect(end.scheduledAt).toBe(proposed);
    });
  });

  describe('app contract', () => {
    it('publishes short status labels for the apps in the reference data', async () => {
      const ref = await api.http().get('/api/v1/reference-data');
      expect(ref.status).toBe(200);
      expect(ref.body.statusLabels.interview).toMatchObject({
        REQUESTED: 'Waiting for worker',
        CONFIRMED: 'Confirmed',
        COMPLETED: 'Done',
      });
      expect(ref.body.statusLabels.booking).toMatchObject({
        MATCHED: 'Worker matched',
        ACTIVE: 'In service',
      });
    });
  });
});
