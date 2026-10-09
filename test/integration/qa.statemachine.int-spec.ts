import '../support/env-api-integration';
import { writeFileSync } from 'node:fs';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp } from '../support/api-app';
import { approveCheck, as, createArea, onboardWorker, OnboardedWorker, setRequiredChecks } from '../support/workforce';

type State =
  | 'NEW_REQUEST' | 'MATCHED' | 'INTERVIEW_TRIAL_SCHEDULED' | 'INTERVIEW_TRIAL_COMPLETED' | 'PENDING_PAYMENT'
  | 'CONFIRMED' | 'ACTIVE' | 'REPLACEMENT_REQUESTED' | 'REPLACED' | 'COMPLETED' | 'CANCELLED';
type Actor = 'CUSTOMER' | 'WORKER' | 'ADMIN';

const STATES: State[] = ['NEW_REQUEST', 'MATCHED', 'INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED', 'PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED', 'CANCELLED'];
const ACTIONS = ['match', 'schedule', 'decline', 'reopen-matching', 'interview-complete', 'confirm-worker', 'start', 'complete', 'cancel'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * The FRD section 4 model (PROPOSED), written down here independently of the implementation: for each action, who may
 * trigger it and from which state it leads to which state.
 */
const SPEC: Record<Action, { actors: Actor[]; moves: Array<[State, State]> }> = {
  match: { actors: ['ADMIN'], moves: [['NEW_REQUEST', 'MATCHED']] },
  schedule: { actors: ['CUSTOMER', 'WORKER', 'ADMIN'], moves: [['MATCHED', 'INTERVIEW_TRIAL_SCHEDULED']] },
  decline: { actors: ['WORKER', 'ADMIN'], moves: [['MATCHED', 'NEW_REQUEST'], ['INTERVIEW_TRIAL_SCHEDULED', 'MATCHED']] },
  'reopen-matching': { actors: ['CUSTOMER', 'ADMIN'], moves: [['INTERVIEW_TRIAL_SCHEDULED', 'MATCHED'], ['INTERVIEW_TRIAL_COMPLETED', 'MATCHED']] },
  'interview-complete': { actors: ['CUSTOMER', 'ADMIN'], moves: [['INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED']] },
  'confirm-worker': { actors: ['CUSTOMER', 'ADMIN'], moves: [['INTERVIEW_TRIAL_COMPLETED', 'PENDING_PAYMENT']] },
  start: { actors: ['CUSTOMER', 'WORKER', 'ADMIN'], moves: [['CONFIRMED', 'ACTIVE']] },
  complete: { actors: ['CUSTOMER', 'ADMIN'], moves: [['ACTIVE', 'COMPLETED']] },
  cancel: {
    actors: ['CUSTOMER', 'ADMIN'],
    moves: (['NEW_REQUEST', 'MATCHED', 'INTERVIEW_TRIAL_SCHEDULED', 'INTERVIEW_TRIAL_COMPLETED', 'PENDING_PAYMENT', 'CONFIRMED', 'REPLACEMENT_REQUESTED'] as State[]).map((s) => [s, 'CANCELLED'] as [State, State]),
  },
};
/** Payment confirmation (PENDING_PAYMENT -> CONFIRMED) and the replacement transitions are system/other-module moves, tested elsewhere. */

describe('QA - booking state machine, exhaustively (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let customer: Awaited<ReturnType<typeof loginWithOtp>>;
  let worker: OnboardedWorker;
  let areaId: string;
  let categoryId: string;
  const observed: Record<string, string> = {};

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    areaId = (await createArea(api, admin)).id;
    await setRequiredChecks(api, admin, ['IDENTITY']);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    worker = await onboardWorker(api, { areaIds: [areaId] });
    await approveCheck(api, admin, worker, 'IDENTITY');
    categoryId = (await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code: 'HOUSE_MAID' } })).id;
  }, 120_000);

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    if (process.env.QA_STATE_OUT) writeFileSync(process.env.QA_STATE_OUT, JSON.stringify(observed, null, 1));
    await api.close();
  });

  /** A booking in exactly this state, satisfying the database CHECK constraints. */
  async function bookingIn(state: State): Promise<string> {
    const future = new Date(Date.now() + 2 * 86400000);
    const start = new Date(Date.now() + 86400000);
    const needsWorker = state !== 'NEW_REQUEST';
    const scheduled = state === 'INTERVIEW_TRIAL_SCHEDULED' || state === 'INTERVIEW_TRIAL_COMPLETED';
    const dated = ['PENDING_PAYMENT', 'CONFIRMED', 'ACTIVE', 'REPLACEMENT_REQUESTED', 'REPLACED', 'COMPLETED'].includes(state);
    const row = await api.prisma.booking.create({
      data: {
        customerUserId: customer.userId,
        workerId: needsWorker ? worker.workerId : null,
        categoryId,
        areaId,
        engagement: 'PART_TIME',
        fromMinute: 540,
        toMinute: 720,
        status: state,
        scheduleType: scheduled ? 'INTERVIEW' : null,
        scheduledAt: scheduled ? future : null,
        startDate: dated ? new Date(start.toISOString().slice(0, 10)) : null,
        cancelReason: state === 'CANCELLED' ? 'seeded' : null,
        cancelledAt: state === 'CANCELLED' ? new Date() : null,
        cancelledByUserId: state === 'CANCELLED' ? customer.userId : null,
      },
    });
    return row.id;
  }

  const bodyFor = (action: Action): object => ({
    match: { workerId: worker.workerId },
    schedule: { scheduleType: 'INTERVIEW', scheduledAt: new Date(Date.now() + 3 * 86400000).toISOString() },
    'interview-complete': { outcomeNote: 'ok' },
    'confirm-worker': { startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10) },
    cancel: { reason: 'matrix' },
    decline: {}, 'reopen-matching': {}, start: {}, complete: {},
  })[action];

  const call = (actor: Actor, id: string, action: Action) => {
    const token = actor === 'CUSTOMER' ? customer : actor === 'WORKER' ? worker : admin;
    const base = actor === 'CUSTOMER' ? '/api/v1/bookings' : actor === 'WORKER' ? '/api/v1/workers/me/bookings' : '/api/v1/admin/bookings';
    return as(api, token).post(`${base}/${id}/${action}`, bodyFor(action));
  };
  const statusOf = async (id: string) => (await api.prisma.booking.findUniqueOrThrow({ where: { id } })).status;
  const retire = (id: string) => api.prisma.$executeRaw`UPDATE bookings SET status = 'COMPLETED', start_date = coalesce(start_date, current_date), worker_id = coalesce(worker_id, ${worker.workerId}::uuid), cancel_reason = NULL, cancelled_at = NULL, cancelled_by_user_id = NULL, scheduled_at = NULL, schedule_type = NULL WHERE id = ${id}::uuid`;

  it('behaves exactly as the FRD model says for every state, action and actor (297 combinations)', async () => {
    const wrong: string[] = [];
    let probes = 0;
    for (const state of STATES) {
      for (const action of ACTIONS) {
        for (const actor of ['CUSTOMER', 'WORKER', 'ADMIN'] as Actor[]) {
          const spec = SPEC[action];
          const move = spec.moves.find(([from]) => from === state);
          const isTarget = spec.moves.some(([, to]) => to === state);
          let expectedStatus: number;
          let expectedState: State = state;
          if (!spec.actors.includes(actor)) expectedStatus = 403;
          else if (move) { expectedStatus = 200; expectedState = move[1]; }
          else if (isTarget && action !== 'decline' && action !== 'reopen-matching') expectedStatus = 200; // repeat of the move that already holds
          else expectedStatus = 409;
          // "match" repeated needs the same worker; "schedule"/"confirm" repeats need the same values, which the seeded rows do not hold.
          if (!move && isTarget && (action === 'schedule' || action === 'confirm-worker' || action === 'match')) expectedStatus = action === 'match' ? 200 : 409;
          const id = await bookingIn(state);
          const res = await call(actor, id, action);
          probes++;
          const after = await statusOf(id);
          observed[`${state} | ${action} | ${actor}`] = `${res.status}${after !== state ? ` -> ${after}` : ''}`;
          if (res.status !== expectedStatus || after !== expectedState) {
            wrong.push(`${state} ${action} by ${actor}: got ${res.status}/${after}, expected ${expectedStatus}/${expectedState}`);
          }
          await retire(id);
        }
      }
    }
    expect(probes).toBe(297);
    expect(wrong).toEqual([]);
  }, 280_000);

  it('records exactly one transition when every party tries the same transition at once', async () => {
    for (const [state, action, target] of [['CONFIRMED', 'start', 'ACTIVE'], ['ACTIVE', 'complete', 'COMPLETED'], ['PENDING_PAYMENT', 'cancel', 'CANCELLED']] as Array<[State, Action, State]>) {
      const id = await bookingIn(state);
      const actors: Actor[] = action === 'start' ? ['CUSTOMER', 'WORKER', 'ADMIN', 'CUSTOMER', 'WORKER', 'ADMIN'] : ['CUSTOMER', 'ADMIN', 'CUSTOMER', 'ADMIN', 'CUSTOMER', 'ADMIN'];
      const results = await Promise.all(actors.map((a) => call(a, id, action)));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await statusOf(id)).toBe(target);
      const events = await api.prisma.bookingEvent.findMany({ where: { bookingId: id, toStatus: target } });
      expect(events).toHaveLength(1);
      await retire(id);
    }
  });

  it('lets exactly one of two conflicting transitions win and leaves a consistent state', async () => {
    const id = await bookingIn('INTERVIEW_TRIAL_COMPLETED');
    const results = await Promise.all([
      call('CUSTOMER', id, 'confirm-worker'), call('ADMIN', id, 'cancel'), call('CUSTOMER', id, 'reopen-matching'),
      call('ADMIN', id, 'confirm-worker'), call('CUSTOMER', id, 'cancel'), call('ADMIN', id, 'reopen-matching'),
    ]);
    const final = await statusOf(id);
    expect(['PENDING_PAYMENT', 'CANCELLED', 'MATCHED']).toContain(final);
    const out = await api.prisma.bookingEvent.findMany({ where: { bookingId: id, fromStatus: 'INTERVIEW_TRIAL_COMPLETED' } });
    expect(out).toHaveLength(1);
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    // The final row satisfies every CHECK constraint by construction (the database accepted every write).
    await retire(id);
  });
});
