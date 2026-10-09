import '../support/env-api-integration';
import {
  ApiApp,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
  unique,
} from '../support/api-app';
import { makeBooking } from '../support/bookings';
import { as, createArea, setRequiredChecks } from '../support/workforce';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const S = '/api/v1/support';
const T = `${S}/tickets`;
const A = '/api/v1/admin/support';
const AT = `${A}/tickets`;

/** Support / complaints against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Support API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let manager: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let viewer: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let area: { id: string };
  let customer: Awaited<ReturnType<typeof loginWithOtp>> & { userId: string };
  let categoryId: string;

  const raise = (body: object = {}, caller: { accessToken: string } = customer) =>
    as(api, caller).post(T, { categoryId, description: 'The worker did not arrive', ...body });
  const ticketId = async (body: object = {}, caller: { accessToken: string } = customer) =>
    (await raise(body, caller).expect(201)).body.id as string;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    manager = await loginAdminWithPermissions(api, ['support.manage', 'support.view']);
    viewer = await loginAdminWithPermissions(api, ['support.view']);
    area = await createArea(api, admin);
    customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await setRequiredChecks(api, admin, ['IDENTITY']);
    const created = await as(api, admin)
      .post(`${A}/categories`, { code: `COMPLAINT_${unique().toUpperCase()}`, name: 'Complaint' })
      .expect(201);
    categoryId = created.body.id;
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('categories', () => {
    it('are an admin-configured list; only enabled ones can be chosen', async () => {
      const mine = await as(api, customer).get(`${S}/categories`).expect(200);
      expect(mine.body.map((c: { id: string }) => c.id)).toContain(categoryId);
      expect(Object.keys(mine.body[0] as object).sort()).toEqual(['code', 'id', 'name']);

      const disabled = (
        await as(api, admin)
          .post(`${A}/categories`, { code: `OLD_${unique().toUpperCase()}`, name: 'Old' })
          .expect(201)
      ).body.id as string;
      await as(api, admin).patch(`${A}/categories/${disabled}`, { isEnabled: false }).expect(200);
      expect(
        (await as(api, customer).get(`${S}/categories`)).body.map((c: { id: string }) => c.id),
      ).not.toContain(disabled);
      const res = await raise({ categoryId: disabled });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SUPPORT_CATEGORY_INVALID');
      expect((await raise({ categoryId: UNKNOWN_ID })).status).toBe(422);
    });

    it('are managed only with support.category.manage and are audited; codes are unique', async () => {
      const code = `PAY_${unique().toUpperCase()}`;
      expect((await as(api, manager).post(`${A}/categories`, { code, name: 'x' })).status).toBe(
        403,
      );
      expect((await as(api, customer).post(`${A}/categories`, { code, name: 'x' })).status).toBe(
        403,
      );
      expect(
        (await as(api, admin).post(`${A}/categories`, { code: 'bad code', name: 'x' })).status,
      ).toBe(400);
      const created = await as(api, admin)
        .post(`${A}/categories`, { code, name: 'Payments' })
        .expect(201);
      expect((await as(api, admin).post(`${A}/categories`, { code, name: 'Again' })).status).toBe(
        409,
      );
      expect(
        (await as(api, admin).patch(`${A}/categories/${UNKNOWN_ID}`, { name: 'n' })).status,
      ).toBe(404);
      const actions = await api.prisma.auditLog.findMany({
        where: { entityType: 'support_category', entityId: created.body.id },
      });
      expect(actions.map((a) => a.action)).toEqual(['support_category.create']);
      const all = await as(api, viewer).get(`${A}/categories`).expect(200);
      expect(all.body.map((c: { id: string }) => c.id)).toContain(created.body.id);
      expect((await as(api, customer).get(`${A}/categories`)).status).toBe(403);
    });
  });

  describe('raising a ticket', () => {
    it('creates an OPEN ticket for a customer and for a worker', async () => {
      const res = await raise();
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'OPEN',
        description: 'The worker did not arrive',
        bookingId: null,
        resolution: null,
        category: { id: categoryId },
      });
      expect(res.body.history.map((h: { type: string }) => h.type)).toEqual(['CREATED']);
      const stored = await api.prisma.supportTicket.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(stored).toMatchObject({ creatorUserId: customer.userId, creatorKind: 'CUSTOMER' });

      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      const fromWorker = await raise({ bookingId: b.id }, b.worker);
      expect(fromWorker.status).toBe(201);
      expect(
        (await api.prisma.supportTicket.findUniqueOrThrow({ where: { id: fromWorker.body.id } }))
          .creatorKind,
      ).toBe('WORKER');
    });

    it('validates input', async () => {
      expect((await raise({ description: '   ' })).status).toBe(400);
      expect((await raise({ description: 'x'.repeat(4001) })).status).toBe(400);
      expect((await raise({ categoryId: 'nope' })).status).toBe(400);
      expect((await raise({ bookingId: 'nope' })).status).toBe(400);
      expect((await as(api, customer).post(T, { description: 'no category' })).status).toBe(400);
    });

    it('lets a ticket point only at a booking the creator is a party to', async () => {
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      expect((await raise({ bookingId: b.id })).status).toBe(201);
      expect((await raise({ bookingId: b.id }, b.worker)).status).toBe(201);
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const otherWorker = (await makeBooking(api, admin, customer, area.id, 'MATCHED')).worker;
      for (const caller of [stranger, otherWorker]) {
        const res = await raise({ bookingId: b.id }, caller);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('BOOKING_NOT_FOUND');
      }
      expect((await raise({ bookingId: UNKNOWN_ID })).status).toBe(404);
      expect(await api.prisma.supportTicket.count({ where: { bookingId: b.id } })).toBe(2);
    });

    it('is refused for admins and anonymous callers', async () => {
      expect((await raise({}, admin)).status).toBe(403);
      expect((await api.http().post(T).send({ categoryId, description: 'x' })).status).toBe(401);
      expect((await as(api, admin).get(T)).status).toBe(403);
    });

    it('audits the creation without the description', async () => {
      const id = await ticketId({ description: 'private complaint wording' });
      const rows = await api.prisma.auditLog.findMany({
        where: { action: 'ticket.create', entityId: id },
      });
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].metadata)).not.toContain('private complaint wording');
    });
  });

  describe('ownership (no access to anyone else ticket)', () => {
    it('shows a user only their own tickets', async () => {
      const id = await ticketId();
      const stranger = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(`${T}/${id}`)).body.id).toBe(id);
      const own = await as(api, customer).get(`${T}?limit=100&status=OPEN`).expect(200);
      expect(own.body.data.map((t: { id: string }) => t.id)).toContain(id);
      const foreign = await as(api, stranger).get(`${T}/${id}`);
      const unknown = await as(api, stranger).get(`${T}/${UNKNOWN_ID}`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe(unknown.body.code);
      expect((await as(api, stranger).get(T)).body.meta.total).toBe(0);
      // a worker cannot read a customer ticket either
      const b = await makeBooking(api, admin, customer, area.id, 'MATCHED');
      expect((await as(api, b.worker).get(`${T}/${id}`)).status).toBe(404);
      expect((await as(api, customer).get(`${T}/not-a-uuid`)).status).toBe(400);
    });

    it('never gives the creator staff notes or staff identities', async () => {
      const id = await ticketId();
      await as(api, manager)
        .post(`${AT}/${id}/assign`, { note: 'internal-only remark' })
        .expect(200);
      await as(api, manager)
        .post(`${AT}/${id}/escalate`, { reason: 'internal escalation reason' })
        .expect(200);
      await as(api, manager).post(`${AT}/${id}/priority`, { priority: 'HIGH' }).expect(200);
      const seen = JSON.stringify((await as(api, customer).get(`${T}/${id}`)).body);
      expect(seen).not.toContain('internal-only remark');
      expect(seen).not.toContain('internal escalation reason');
      expect(seen).not.toContain(manager.userId);
      expect(seen).not.toContain('actorUserId');
      expect(seen).not.toContain('HIGH');
    });
  });

  describe('staff handling', () => {
    it('lists and reads with support.view only', async () => {
      const id = await ticketId();
      const list = await as(api, viewer)
        .get(`${AT}?limit=100&unassigned=true&status=OPEN`)
        .expect(200);
      expect(list.body.data.map((t: { id: string }) => t.id)).toContain(id);
      const detail = await as(api, viewer).get(`${AT}/${id}`).expect(200);
      expect(detail.body).toMatchObject({
        id,
        creatorUserId: customer.userId,
        creatorKind: 'CUSTOMER',
      });
      expect((await as(api, viewer).get(`${AT}?priority=BOGUS`)).status).toBe(400);
      const nobody = await loginAdminWithPermissions(api, []);
      for (const caller of [nobody, customer]) {
        expect((await as(api, caller).get(AT)).status).toBe(403);
        expect((await as(api, caller).get(`${AT}/${id}`)).status).toBe(403);
      }
      expect((await api.http().get(AT)).status).toBe(401);
      expect((await as(api, viewer).get(`${AT}/${UNKNOWN_ID}`)).status).toBe(404);
    });

    it('requires support.manage for every change', async () => {
      const id = await ticketId();
      const calls: Array<[string, object]> = [
        ['assign', {}],
        ['priority', { priority: 'LOW' }],
        ['escalate', { reason: 'r' }],
        ['close', { resolution: 'r' }],
      ];
      for (const [action, body] of calls) {
        expect((await as(api, viewer).post(`${AT}/${id}/${action}`, body)).status).toBe(403);
        expect((await as(api, customer).post(`${AT}/${id}/${action}`, body)).status).toBe(403);
        expect((await api.http().post(`${AT}/${id}/${action}`).send(body)).status).toBe(401);
      }
      expect((await api.prisma.supportTicket.findUniqueOrThrow({ where: { id } })).status).toBe(
        'OPEN',
      );
    });

    it('runs the lifecycle OPEN, IN_PROGRESS, ESCALATED, CLOSED with history, audit and notifications', async () => {
      const id = await ticketId();
      const assigned = await as(api, manager).post(`${AT}/${id}/assign`, {}).expect(200);
      expect(assigned.body).toMatchObject({
        status: 'IN_PROGRESS',
        assignedToUserId: manager.userId,
      });

      const prioritised = await as(api, manager)
        .post(`${AT}/${id}/priority`, { priority: 'HIGH' })
        .expect(200);
      expect(prioritised.body.priority).toBe('HIGH');

      const escalated = await as(api, manager)
        .post(`${AT}/${id}/escalate`, { reason: 'Safety concern' })
        .expect(200);
      expect(escalated.body.status).toBe('ESCALATED');
      await as(api, manager).post(`${AT}/${id}/escalate`, { reason: 'again' }).expect(200);

      expect((await as(api, manager).post(`${AT}/${id}/close`, {})).status).toBe(400);
      expect((await as(api, manager).post(`${AT}/${id}/close`, { resolution: '  ' })).status).toBe(
        400,
      );
      const closed = await as(api, manager)
        .post(`${AT}/${id}/close`, { resolution: 'Refund arranged' })
        .expect(200);
      expect(closed.body).toMatchObject({
        status: 'CLOSED',
        resolution: 'Refund arranged',
        closedByUserId: manager.userId,
      });
      expect(closed.body.history.map((h: { type: string }) => h.type)).toEqual([
        'CREATED',
        'ASSIGNED',
        'PRIORITY_SET',
        'ESCALATED',
        'CLOSED',
      ]);

      // the creator sees the resolution and the progress, nothing internal
      const seen = (await as(api, customer).get(`${T}/${id}`)).body;
      expect(seen).toMatchObject({ status: 'CLOSED', resolution: 'Refund arranged' });
      expect(seen.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        'OPEN',
        'IN_PROGRESS',
        'IN_PROGRESS',
        'ESCALATED',
        'CLOSED',
      ]);

      // a closed ticket is final
      for (const [action, body] of [
        ['assign', {}],
        ['priority', { priority: 'LOW' }],
        ['escalate', { reason: 'x' }],
        ['close', { resolution: 'again' }],
      ] as Array<[string, object]>) {
        const res = await as(api, manager).post(`${AT}/${id}/${action}`, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('TICKET_CLOSED');
      }

      const audit = await api.prisma.auditLog.findMany({
        where: { entityType: 'support_ticket', entityId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual([
        'ticket.create',
        'ticket.assign',
        'ticket.priority',
        'ticket.escalate',
        'ticket.close',
      ]);
      const events = await api.prisma.outboxEvent.findMany({
        where: { payload: { path: ['params', 'ticketId'], equals: id } },
      });
      expect(
        events.map((e) => (e.payload as { params: { status: string } }).params.status).sort(),
      ).toEqual(['CLOSED', 'ESCALATED', 'IN_PROGRESS']);
      for (const e of events) {
        expect((e.payload as { recipients: string[] }).recipients).toEqual([customer.userId]);
      }
    });

    it('assigns only to an active admin who can manage tickets', async () => {
      const id = await ticketId();
      const other = await loginAdminWithPermissions(api, ['support.manage']);
      const assigned = await as(api, manager)
        .post(`${AT}/${id}/assign`, { assigneeUserId: other.userId })
        .expect(200);
      expect(assigned.body.assignedToUserId).toBe(other.userId);
      for (const assigneeUserId of [viewer.userId, customer.userId, UNKNOWN_ID]) {
        const res = await as(api, manager).post(`${AT}/${id}/assign`, { assigneeUserId });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('ASSIGNEE_INVALID');
      }
      await api.prisma.user.update({ where: { id: other.userId }, data: { status: 'SUSPENDED' } });
      expect(
        (await as(api, manager).post(`${AT}/${id}/assign`, { assigneeUserId: other.userId }))
          .status,
      ).toBe(422);
      expect(
        (await api.prisma.supportTicket.findUniqueOrThrow({ where: { id } })).assignedToUserId,
      ).toBe(other.userId);
    });

    it('serialises concurrent changes: one close wins, the rest are refused', async () => {
      const id = await ticketId();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          as(api, manager).post(`${AT}/${id}/close`, { resolution: `resolution ${i}` }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      const closedEvents = await api.prisma.supportTicketEvent.count({
        where: { ticketId: id, type: 'CLOSED' },
      });
      expect(closedEvents).toBe(1);
    });

    it('keeps the history append-only and the database rules in force', async () => {
      const id = await ticketId();
      await expect(
        api.prisma.supportTicketEvent.updateMany({ where: { ticketId: id }, data: { type: 'X' } }),
      ).rejects.toThrow();
      await expect(
        api.prisma.supportTicketEvent.deleteMany({ where: { ticketId: id } }),
      ).rejects.toThrow();
      await expect(
        api.prisma.supportTicket.update({ where: { id }, data: { status: 'CLOSED' } }),
      ).rejects.toThrow();
    });
  });
});
