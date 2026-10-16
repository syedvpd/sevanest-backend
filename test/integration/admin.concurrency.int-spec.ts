import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import { AppConfigService } from '../../src/config/app-config.service';
import { as, createArea, onboardWorker } from '../support/workforce';

const A = '/api/v1/admin';

type Caller = Awaited<ReturnType<typeof loginAdmin>>;

/** DEC-16: admin edits carry If-Match. 428 without it, 412 STALE_VERSION when a second admin edits an outdated copy. */
describe('Admin edit conflicts (integration)', () => {
  let api: ApiApp;
  let first: Caller;
  let second: Caller;
  let required: jest.SpyInstance;

  beforeAll(async () => {
    api = await createApiApp();
    first = await loginAdmin(api);
    second = first; // the same Super Admin account is enough: the version, not the person, decides
    required = jest
      .spyOn(api.app.get(AppConfigService), 'adminIfMatchRequired', 'get')
      .mockReturnValue(true);
  });
  afterAll(async () => {
    required.mockRestore();
    await api.close();
  });

  const etagOf = async (caller: Caller, url: string): Promise<string> => {
    const res = await as(api, caller).get(url).expect(200);
    const etag = res.headers['etag'] as string | undefined;
    expect(etag).toBeTruthy();
    return etag!;
  };
  const withMatch = (
    caller: Caller,
    method: 'patch' | 'put' | 'post',
    url: string,
    body: object,
    ifMatch?: string,
  ) => {
    const req = api.http()[method](url).set('Authorization', `Bearer ${caller.accessToken}`);
    if (ifMatch !== undefined) req.set('If-Match', ifMatch);
    return req.send(body);
  };

  /** missing header -> 428; two admins on the same version -> the second gets 412 and changes nothing; * overrides. */
  async function exercise(options: {
    getUrl: string;
    method: 'patch' | 'put' | 'post';
    url: string;
    bodies: [object, object, object];
    read: () => Promise<unknown>;
  }): Promise<void> {
    const etag = await etagOf(first, options.getUrl);
    const missing = await withMatch(first, options.method, options.url, options.bodies[0]);
    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe('PRECONDITION_REQUIRED');
    const stateBefore = JSON.stringify(await options.read());

    const win = await withMatch(first, options.method, options.url, options.bodies[0], etag);
    expect(win.status).toBeLessThan(300);
    const afterWin = JSON.stringify(await options.read());
    expect(afterWin).not.toBe(stateBefore);

    const lose = await withMatch(second, options.method, options.url, options.bodies[1], etag);
    expect(lose.status).toBe(412);
    expect(lose.body.code).toBe('STALE_VERSION');
    expect(JSON.stringify(await options.read())).toBe(afterWin); // the stale edit changed nothing

    const star = await withMatch(second, options.method, options.url, options.bodies[2], '*');
    expect(star.status).toBeLessThan(300);
  }

  it('user status (users)', async () => {
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await exercise({
      getUrl: `${A}/users/${customer.userId}`,
      method: 'patch',
      url: `${A}/users/${customer.userId}/status`,
      bodies: [
        { status: 'SUSPENDED', reason: 'first admin' },
        { status: 'ACTIVE', reason: 'second admin' },
        { status: 'ACTIVE', reason: 'second admin overrides' },
      ],
      read: async () =>
        (await api.prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).status,
    });
  });

  it('service area (areas)', async () => {
    const area = await createArea(api, first);
    await exercise({
      getUrl: `${A}/service-areas/${area.id}`,
      method: 'patch',
      url: `${A}/service-areas/${area.id}`,
      bodies: [{ name: `A ${unique()}` }, { name: `B ${unique()}` }, { name: `C ${unique()}` }],
      read: async () =>
        (await api.prisma.serviceArea.findUniqueOrThrow({ where: { id: area.id } })).name,
    });
  });

  it('worker profile (workers)', async () => {
    const worker = await onboardWorker(api, { submit: false });
    await exercise({
      getUrl: `${A}/workers/${worker.workerId}`,
      method: 'patch',
      url: `${A}/workers/${worker.workerId}`,
      bodies: [{ experienceMonths: 10 }, { experienceMonths: 20 }, { experienceMonths: 30 }],
      read: async () =>
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } }))
          .experienceMonths,
    });
  });

  it('customer verification status (customers)', async () => {
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    await as(api, customer)
      .post('/api/v1/customers/me', {
        name: 'Conflict Test',
        email: `conflict.${unique()}@example.test`,
        preferredLanguage: 'en',
      })
      .expect(201);
    const profile = await api.prisma.customerProfile.findUniqueOrThrow({
      where: { userId: customer.userId },
    });
    await exercise({
      getUrl: `${A}/customers/${profile.id}`,
      method: 'patch',
      url: `${A}/customers/${profile.id}/verification-status`,
      bodies: [{ status: 'VERIFIED' }, { status: 'PENDING' }, { status: 'VERIFIED' }],
      read: async () =>
        (await api.prisma.customerProfile.findUniqueOrThrow({ where: { id: profile.id } }))
          .verificationStatus,
    });
  });

  it('support ticket actions (support tickets)', async () => {
    const category = (
      await as(api, first)
        .post(`${A}/support/categories`, {
          code: `CC_${unique().toUpperCase().slice(0, 8)}`,
          name: 'Conflicts',
        })
        .expect(201)
    ).body as { id: string };
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const ticket = (
      await as(api, customer)
        .post('/api/v1/support/tickets', { categoryId: category.id, description: 'Needs a hand' })
        .expect(201)
    ).body as { id: string };
    await exercise({
      getUrl: `${A}/support/tickets/${ticket.id}`,
      method: 'post',
      url: `${A}/support/tickets/${ticket.id}/priority`,
      bodies: [{ priority: 'HIGH' }, { priority: 'LOW' }, { priority: 'MEDIUM' }],
      read: async () =>
        (await api.prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).priority,
    });
    // the other state-changing ticket actions are guarded the same way
    for (const action of ['assign', 'escalate', 'close']) {
      const res = await withMatch(first, 'post', `${A}/support/tickets/${ticket.id}/${action}`, {
        reason: 'r',
        resolution: 'r',
      });
      expect(res.status).toBe(428);
    }
  });

  it('is off when ADMIN_IF_MATCH_REQUIRED is false (header optional, a stale one still refused)', async () => {
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    required.mockReturnValue(false);
    try {
      const etag = await etagOf(first, `${A}/users/${customer.userId}`);
      await withMatch(first, 'patch', `${A}/users/${customer.userId}/status`, {
        status: 'SUSPENDED',
        reason: 'no header needed',
      }).expect(200);
      const stale = await withMatch(
        first,
        'patch',
        `${A}/users/${customer.userId}/status`,
        { status: 'ACTIVE', reason: 'old copy' },
        etag,
      );
      expect(stale.status).toBe(412);
    } finally {
      required.mockReturnValue(true);
    }
  });
});
