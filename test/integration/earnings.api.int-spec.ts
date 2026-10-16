import '../support/env-api-integration';
import { randomUUID } from 'node:crypto';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import { ensureFee, makeBooking, TestBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const A = '/api/v1/admin';
const ME = '/api/v1/workers/me/earnings';

const entry = (over: Record<string, unknown> = {}) => ({
  amountMinor: 1_200_000,
  periodLabel: '2026-11',
  method: 'UPI',
  referenceText: 'UPI ref 4821',
  ...over,
});

/** Worker earnings reference (FR-WJ-008, DEC-05): record, correct, void; worker read-only; IDOR; append-only. */
describe('Worker earnings reference (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let manager: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let viewer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };
  let one: TestBooking;
  let two: TestBooking;

  const record = (bookingId: string, body: object = entry()) =>
    as(api, manager).post(`${A}/wage-payments`, { bookingId, ...body });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    area = await createArea(api, admin);
    await ensureFee(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    manager = await loginAdminWithPermissions(api, ['payment.manage', 'payment.view']);
    viewer = await loginAdminWithPermissions(api, ['payment.view']);
    one = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
    two = await makeBooking(api, admin, customer, area.id, 'ACTIVE');
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  it('staff with payment.manage record an entry; nobody else can', async () => {
    const res = await record(one.id).expect(201);
    expect(res.body).toMatchObject({
      bookingId: one.id,
      workerId: one.worker.workerId,
      amountMinor: 1_200_000,
      currency: 'INR',
      periodLabel: '2026-11',
      method: 'UPI',
      referenceText: 'UPI ref 4821',
      correctsId: null,
      isVoid: false,
      superseded: false,
    });
    const url = `${A}/wage-payments`;
    const body = entry({ bookingId: one.id });
    expect((await as(api, viewer).post(url, body)).status).toBe(403);
    expect((await as(api, customer).post(url, body)).status).toBe(403);
    expect((await as(api, one.worker).post(url, body)).status).toBe(403);
    expect((await api.http().post(url).send(body)).status).toBe(401);
    const audit = await api.prisma.auditLog.findFirstOrThrow({
      where: { entityId: res.body.id as string, action: 'earnings.wage_payment_recorded' },
    });
    expect(audit.actorId).toBe(manager.userId);
    expect(JSON.stringify(audit.metadata)).not.toContain('UPI ref 4821');
  });

  it('validates the entry and the booking', async () => {
    for (const bad of [
      entry({ amountMinor: 0 }),
      entry({ amountMinor: -5 }),
      entry({ amountMinor: 1.5 }),
      entry({ method: 'BITCOIN' }),
      entry({ periodLabel: '' }),
      entry({ referenceText: 'x'.repeat(201) }),
      {},
    ]) {
      expect((await record(one.id, bad)).status).toBe(400);
    }
    expect((await record(randomUUID())).status).toBe(404);
    expect((await record('not-a-uuid')).status).toBe(400);
    expect((await as(api, manager).post(`${A}/wage-payments`, entry())).status).toBe(400);
    const notStarted = await makeBooking(api, admin, customer, area.id, 'CONFIRMED');
    const early = await record(notStarted.id);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('BOOKING_NOT_STARTED');
  });

  it('shows the worker their own entries and total, paginated; another worker sees nothing of it (IDOR)', async () => {
    await record(one.id, entry({ amountMinor: 300_000, referenceText: 'cash 1' })).expect(201);
    await record(one.id, entry({ amountMinor: 400_000, referenceText: 'cash 2' })).expect(201);
    const mine = await as(api, one.worker).get(`${ME}?limit=2`).expect(200);
    expect(mine.body.data).toHaveLength(2);
    expect(mine.body.meta).toMatchObject({ page: 1, limit: 2, total: 3 });
    // totals cover every counted entry, not just the page
    expect(mine.body.totals).toEqual({ currency: 'INR', amountMinor: 1_900_000, paymentCount: 3 });
    expect(mine.body.data[0]).not.toHaveProperty('workerId');
    expect(mine.body.data[0]).not.toHaveProperty('recordedByUserId');
    const page2 = await as(api, one.worker).get(`${ME}?limit=2&page=2`).expect(200);
    expect(page2.body.data).toHaveLength(1);

    const other = await as(api, two.worker).get(ME).expect(200);
    expect(other.body.data).toEqual([]);
    expect(other.body.totals).toEqual({ currency: 'INR', amountMinor: 0, paymentCount: 0 });
    expect(JSON.stringify(other.body)).not.toContain(one.id);
    await record(two.id, entry({ amountMinor: 5_000 })).expect(201);
    const mineAgain = await as(api, one.worker).get(ME).expect(200);
    expect(mineAgain.body.totals.amountMinor).toBe(1_900_000);

    // Customers, staff and anonymous callers have no worker earnings view.
    expect((await as(api, customer).get(ME)).status).toBe(403);
    expect((await as(api, manager).get(ME)).status).toBe(403);
    expect((await api.http().get(ME)).status).toBe(401);
    // The worker has no write path.
    expect((await as(api, one.worker).post(ME, entry())).status).toBe(404);
  });

  it('is append-only: a correction or void is a new row, the old one stays and stops counting', async () => {
    const created = await record(two.id, entry({ amountMinor: 700_000 })).expect(201);
    const before = (await as(api, two.worker).get(ME).expect(200)).body.totals
      .amountMinor as number;

    const fixed = await as(api, manager)
      .post(`${A}/wage-payments/${created.body.id}/correct`, entry({ amountMinor: 650_000 }))
      .expect(201);
    expect(fixed.body).toMatchObject({ correctsId: created.body.id, isVoid: false });
    const afterCorrect = (await as(api, two.worker).get(ME).expect(200)).body;
    expect(afterCorrect.totals.amountMinor).toBe(before - 700_000 + 650_000);
    expect(afterCorrect.data.map((d: { id: string }) => d.id)).not.toContain(created.body.id);

    // The old row cannot be corrected twice, and a replaced row is flagged in the staff history.
    const again = await as(api, manager).post(
      `${A}/wage-payments/${created.body.id}/correct`,
      entry({ amountMinor: 1 }),
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WAGE_PAYMENT_ALREADY_CORRECTED');
    const history = await as(api, viewer)
      .get(`${A}/wage-payments?bookingId=${two.id}&limit=100`)
      .expect(200);
    expect(history.body.data.find((d: { id: string }) => d.id === created.body.id).superseded).toBe(
      true,
    );

    const voided = await as(api, manager)
      .post(`${A}/wage-payments/${fixed.body.id}/void`, { reason: 'entered for the wrong job' })
      .expect(201);
    expect(voided.body).toMatchObject({ isVoid: true, amountMinor: 650_000 });
    const afterVoid = (await as(api, two.worker).get(ME).expect(200)).body.totals.amountMinor;
    expect(afterVoid).toBe(before - 700_000);
    // A voiding row is final.
    const voidAgain = await as(api, manager).post(`${A}/wage-payments/${voided.body.id}/void`, {
      reason: 'again',
    });
    expect(voidAgain.status).toBe(409);
    expect(voidAgain.body.code).toBe('WAGE_PAYMENT_IS_VOID');
    expect(
      (await as(api, manager).post(`${A}/wage-payments/${randomUUID()}/void`, { reason: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await as(api, viewer).post(`${A}/wage-payments/${fixed.body.id}/void`, { reason: 'x' }))
        .status,
    ).toBe(403);

    // The database refuses edits and deletes outright.
    await expect(
      api.prisma
        .$executeRaw`UPDATE worker_payment_references SET amount_minor = 1 WHERE id = ${created.body.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      api.prisma
        .$executeRaw`DELETE FROM worker_payment_references WHERE id = ${created.body.id}::uuid`,
    ).rejects.toThrow();
  });

  it('lets staff with payment.view list entries (filters, pagination) but not without it', async () => {
    const list = await as(api, viewer)
      .get(`${A}/wage-payments?workerId=${one.worker.workerId}&limit=2`)
      .expect(200);
    expect(list.body.meta.total).toBeGreaterThanOrEqual(3);
    expect(
      list.body.data.every((d: { workerId: string }) => d.workerId === one.worker.workerId),
    ).toBe(true);
    const noPermission = await loginAdminWithPermissions(api, ['booking.view']);
    expect((await as(api, noPermission).get(`${A}/wage-payments`)).status).toBe(403);
    expect((await as(api, viewer).get(`${A}/wage-payments?workerId=nope`)).status).toBe(400);
  });
});
