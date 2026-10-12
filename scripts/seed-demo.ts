import './seed-demo-env';
import { createApiApp, loginWithOtp } from '../test/support/api-app';
import type { ApiApp } from '../test/support/api-app';
import { as } from '../test/support/workforce';
import type { Caller } from '../test/support/workforce';
import { fakeGateway, inDays } from '../test/support/bookings';

/**
 * Development/demo data created through the real HTTP API (state machines, audit and constraints all apply).
 * Demo accounts are recognisable and removable: mobiles +91900000xxxx, customer emails @example.com.
 * Placeholders, NOT approved policy: booking fee, required verification check, support categories.
 * Notification templates are deliberately not seeded (wording is unapproved).
 */
const AREAS = [
  'Madhapur',
  'Kondapur',
  'Gachibowli',
  'Hitech City',
  'Jubilee Hills',
  'Banjara Hills',
  'Kukatpally',
  'Miyapur',
];
const CITY = 'Hyderabad';
const SUPPORT_CATEGORIES = [
  ['BOOKING_ISSUE', 'Booking issue'],
  ['PAYMENT_ISSUE', 'Payment issue'],
  ['WORKER_CONDUCT', 'Worker conduct'],
  ['APP_PROBLEM', 'App problem'],
  ['OTHER', 'Other'],
] as const;

const WORKERS = [
  ['Lakshmi Devi', 60],
  ['Sunita Yadav', 48],
  ['Padma Reddy', 84],
  ['Rekha Kumari', 24],
  ['Ramesh Naik', 36],
  ['Savitri Bai', 96],
  ['Anwar Hussain', 30],
  ['Geeta Sharma', 72],
  ['Mary Joseph', 18],
  ['Kavitha Rao', 54],
  ['Narsimha Goud', 40],
  ['Bhavani Devi', 12],
] as const;
const CUSTOMERS = [
  ['Anita Rao', 'Madhapur'],
  ['Vikram Singh', 'Kondapur'],
  ['Priya Menon', 'Gachibowli'],
  ['Arjun Reddy', 'Hitech City'],
  ['Fatima Khan', 'Jubilee Hills'],
  ['Suresh Iyer', 'Banjara Hills'],
] as const;

const mobile = (n: number): string => `+91900000${String(n).padStart(4, '0')}`;
const daysAgo = (d: number): string =>
  new Date(Date.now() - d * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);

// A tiny valid PDF, uploaded for real to the private bucket so the KYC documents resolve.
const PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function uploadReal(
  api: ApiApp,
  worker: Caller,
  res: { status: number; body: unknown },
): Promise<void> {
  if (res.status !== 201) throw new Error(`upload url ${res.status} ${JSON.stringify(res.body)}`);
  const body = res.body as Record<string, unknown>;
  const url = (body.uploadUrl ?? body.url ?? (body.upload as { url?: string } | undefined)?.url) as
    | string
    | undefined;
  if (!url) throw new Error(`no upload url in ${JSON.stringify(Object.keys(body))}`);
  const put = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: PDF,
  });
  if (!put.ok) throw new Error(`PUT ${put.status}`);
  await as(api, worker)
    .post(`/api/v1/workers/me/verification/documents/${String(body.documentId)}/confirm`)
    .expect(200);
}

async function main(): Promise<void> {
  const api = await createApiApp();
  const log = (m: string): void => console.log(m);
  try {
    if ((await api.prisma.booking.count()) >= 10) {
      log('Demo bookings already present. Nothing done.');
      return;
    }
    const login = await api
      .http()
      .post('/api/v1/auth/admin/login')
      .set('X-Forwarded-For', '10.9.9.9')
      .send({
        email: process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL,
        password: process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD,
      });
    if (login.status !== 200) throw new Error(`admin login ${login.status}`);
    const admin = login.body as Caller;
    const a = as(api, admin);

    // ---- masters / config ----
    const areaIds: string[] = [];
    for (const name of AREAS) {
      const existing = await api.prisma.serviceArea.findFirst({ where: { name, city: CITY } });
      areaIds.push(
        existing?.id ??
          (
            (await a.post('/api/v1/admin/service-areas', { name, city: CITY }).expect(201))
              .body as { id: string }
          ).id,
      );
    }
    for (const [code, name] of SUPPORT_CATEGORIES) {
      if (!(await api.prisma.supportCategory.findUnique({ where: { code } }))) {
        await a.post('/api/v1/admin/support/categories', { code, name }).expect(201);
      }
    }
    await a.put('/api/v1/admin/fees/booking-fee', { amountMinor: 50000, isActive: true }).expect(200); // PLACEHOLDER
    await a.put('/api/v1/admin/verification/requirements', { checkTypes: ['IDENTITY'] }).expect(200); // PLACEHOLDER
    log(`masters: ${AREAS.length} areas, ${SUPPORT_CATEGORIES.length} support categories, fee + requirement placeholders`);

    // ---- workers ----
    const maid = (await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code: 'HOUSE_MAID' } })).id;
    const workers: Array<Caller & { userId: string; workerId: string }> = [];
    for (let i = 0; i < WORKERS.length; i++) {
      const [name, months] = WORKERS[i];
      const s = await loginWithOtp(api, { appType: 'WORKER', mobile: mobile(101 + i) });
      const w = as(api, s);
      const prior = await w.get('/api/v1/workers/me');
      if (prior.status === 200) {
        // resumed run: the profile was fully built before
        workers.push({ accessToken: s.accessToken, userId: s.userId, workerId: (prior.body as { id: string }).id });
        continue;
      }
      const workerId = ((await w.post('/api/v1/workers/me', { name }).expect(201)).body as { id: string }).id;
      await w
        .patch('/api/v1/workers/me', {
          address: {
            line: `${10 + i} Gandhi Nagar`,
            area: AREAS[i % AREAS.length],
            city: CITY,
            pincode: '5000' + String(81 + (i % 9)),
          },
          emergencyContact: { name: 'Family contact', mobile: `98765${String(43210 + i)}` },
          languages: i % 3 === 0 ? ['en', 'hi', 'te'] : ['hi', 'te'],
          experienceMonths: months,
          expectedSalary: 12000 + (i % 6) * 1500,
        })
        .expect(200);
      await w.put('/api/v1/workers/me/categories', { categoryIds: [maid] }).expect(200);
      await w
        .patch('/api/v1/workers/me/availability', {
          engagementPreference: (['PART_TIME', 'FULL_TIME', 'LIVE_IN'] as const)[i % 3],
          areaIds: [0, 1, 2].map((k) => areaIds[(i + k) % areaIds.length]),
          timeWindows: [{ start: '07:00', end: '19:00' }],
        })
        .expect(200);
      if (i < 11) await w.post('/api/v1/workers/me/submit').expect(200); // the last stays a DRAFT
      workers.push({ accessToken: s.accessToken, userId: s.userId, workerId });
    }
    // KYC: 0-8 approved, 9 in review, 10 submitted, 11 draft (no KYC)
    for (let i = 0; i < 11; i++) {
      const probe = await as(api, workers[i]).post(
        '/api/v1/workers/me/verification/checks/IDENTITY/documents',
        { contentType: 'application/pdf', sizeBytes: PDF.length },
      );
      if (probe.status === 409) continue; // resumed run: already submitted/approved
      await uploadReal(api, workers[i], probe);
      await as(api, workers[i]).post('/api/v1/workers/me/verification/checks/IDENTITY/submit').expect(200);
    }
    const queue = (await a.get('/api/v1/admin/verification/queue?limit=100').expect(200)).body
      .data as Array<{ workerId: string; checkId: string }>;
    for (let i = 0; i < 10; i++) {
      const entry = queue.find((q) => q.workerId === workers[i].workerId);
      if (!entry) continue; // resumed run: already approved
      await a.post(`/api/v1/admin/verification/checks/${entry.checkId}/start-review`);
      if (i < 9) {
        await a
          .post(`/api/v1/admin/verification/checks/${entry.checkId}/approve`, { remarks: 'Identity document checked' })
          .expect(200);
      }
    }
    log(`workers: ${WORKERS.length} (9 verified, 1 in review, 1 submitted, 1 draft); KYC PDFs uploaded to the bucket`);

    // ---- customers ----
    const customers: Array<Caller & { userId: string }> = [];
    for (let i = 0; i < CUSTOMERS.length; i++) {
      const [name, area] = CUSTOMERS[i];
      const s = await loginWithOtp(api, { appType: 'CUSTOMER', mobile: mobile(201 + i) });
      const c = as(api, s);
      if ((await c.get('/api/v1/customers/me')).status === 200) {
        customers.push({ accessToken: s.accessToken, userId: s.userId });
        continue;
      }
      await c
        .post('/api/v1/customers/me', {
          name,
          email: `${name.toLowerCase().replace(/ /g, '.')}@example.com`,
          preferredLanguage: i % 2 ? 'hi' : 'en',
        })
        .expect(201);
      await c
        .post('/api/v1/customers/me/addresses', {
          line: `${20 + i} Road No. ${i + 1}`,
          area,
          city: CITY,
          pincode: '5000' + String(81 + i),
        })
        .expect(201);
      customers.push({ accessToken: s.accessToken, userId: s.userId });
    }
    for (const p of await api.prisma.customerProfile.findMany({ take: 4, orderBy: { createdAt: 'asc' }, select: { id: true } })) {
      await a.patch(`/api/v1/admin/customers/${p.id}/verification-status`, { status: 'VERIFIED' }).expect(200);
    }
    log(`customers: ${CUSTOMERS.length} with addresses (4 verified)`);

    // ---- bookings across the lifecycle ----
    const book = async (ci: number, wi: number): Promise<string> => {
      const r = await as(api, customers[ci]).post('/api/v1/bookings', {
        category: 'HOUSE_MAID',
        areaId: areaIds[wi % areaIds.length], // an area the worker serves
        engagement: (['PART_TIME', 'FULL_TIME', 'LIVE_IN'] as const)[wi % 3], // the worker's preference
        availableFrom: '09:00',
        availableTo: '12:00',
        workerId: workers[wi].workerId,
      });
      if (r.status !== 201) throw new Error(`booking ${r.status} ${JSON.stringify(r.body)}`);
      return (r.body as { id: string }).id;
    };
    const order = ['schedule', 'interview', 'confirm', 'paid'] as const;
    const step = async (ci: number, id: string, upTo: (typeof order)[number]): Promise<void> => {
      const c = as(api, customers[ci]);
      const reach = (s: (typeof order)[number]): boolean => order.indexOf(upTo) >= order.indexOf(s);
      if (reach('schedule')) {
        await c
          .post(`/api/v1/bookings/${id}/schedule`, {
            scheduleType: 'INTERVIEW',
            scheduledAt: new Date(Date.now() + 86400000).toISOString(),
          })
          .expect(200);
      }
      if (reach('interview')) await c.post(`/api/v1/bookings/${id}/interview-complete`, { outcomeNote: 'Good fit' }).expect(200);
      if (reach('confirm')) await c.post(`/api/v1/bookings/${id}/confirm-worker`, { startDate: inDays(1) }).expect(200);
      if (reach('paid')) {
        const pay = (await c.post('/api/v1/payments', { bookingId: id }).expect(201)).body as {
          id: string;
          checkout: { orderId: string };
        };
        const done = fakeGateway(api).completeCheckout(pay.checkout.orderId, 'SUCCEEDED');
        await c.post(`/api/v1/payments/${pay.id}/verify`, done).expect(200);
      }
    };
    const start = async (wi: number, id: string, backDays: number): Promise<void> => {
      await as(api, workers[wi]).post(`/api/v1/workers/me/bookings/${id}/start`).expect(200);
      await api.prisma.$executeRaw`UPDATE bookings SET start_date = ${daysAgo(backDays)}::date WHERE id = ${id}::uuid`;
      for (let d = backDays; d >= 1; d--) {
        await a
          .post(`/api/v1/admin/attendance/bookings/${id}`, { date: daysAgo(d), status: d === 3 ? 'ABSENT' : 'PRESENT' })
          .expect(201);
      }
      await as(api, workers[wi]).post(`/api/v1/workers/me/attendance/bookings/${id}`, { status: 'PRESENT' }).expect(201);
    };

    // matched x2, scheduled, interview done, pending payment, confirmed
    if (!(await api.prisma.booking.count({ where: { customer: { mobile: mobile(201) }, worker: { user: { mobile: mobile(101) } } } }))) {
      await book(0, 0);
    }
    await book(1, 1);
    await step(2, await book(2, 2), 'schedule');
    await step(3, await book(3, 3), 'interview');
    await step(4, await book(4, 4), 'confirm');
    await step(5, await book(5, 5), 'paid');
    // active with attendance history
    const act1 = await book(0, 6);
    await step(0, act1, 'paid');
    await start(6, act1, 5);
    const act2 = await book(1, 7);
    await step(1, act2, 'paid');
    await start(7, act2, 4);
    // completed and rated
    const finished: Array<[number, number, number, string]> = [
      [2, 8, 5, 'Very reliable and punctual.'],
      [3, 0, 4, 'Good work, polite.'],
      [4, 1, 5, 'Excellent, would book again.'],
    ];
    const doneIds: string[] = [];
    for (const [ci, wi, score, review] of finished) {
      const id = await book(ci, wi);
      await step(ci, id, 'paid');
      await start(wi, id, 3);
      await as(api, customers[ci]).post(`/api/v1/bookings/${id}/complete`).expect(200);
      await as(api, customers[ci]).post('/api/v1/ratings', { bookingId: id, score, review }).expect(201);
      doneIds.push(id);
    }
    // cancelled
    const canc = await book(5, 2);
    await as(api, customers[5]).post(`/api/v1/bookings/${canc}/cancel`, { reason: 'Plans changed' }).expect(200);
    // replacement on an active booking
    const repl = await book(2, 3);
    await step(2, repl, 'paid');
    await start(3, repl, 2);
    const rq = (
      await as(api, customers[2])
        .post('/api/v1/replacement-requests', { bookingId: repl, reason: 'Worker often late' })
        .expect(201)
    ).body as { id: string };
    await a.post(`/api/v1/admin/replacement-requests/${rq.id}/approve`, {}).expect(200);
    const cands = (await a.get(`/api/v1/admin/replacement-requests/${rq.id}/candidates?limit=100`).expect(200)).body
      .data as Array<{ workerId: string }>;
    if (cands.length) {
      await as(api, customers[2])
        .post(`/api/v1/replacement-requests/${rq.id}/select`, { workerId: cands[0].workerId })
        .expect(200);
    }

    // ---- support tickets: OPEN / IN_PROGRESS / CLOSED ----
    const cats = await api.prisma.supportCategory.findMany({ orderBy: { code: 'asc' } });
    const cat = (code: string): string => cats.find((c) => c.code === code)!.id;
    const ticket = async (ci: number, bookingId: string, code: string, text: string): Promise<string> =>
      (
        (
          await as(api, customers[ci])
            .post('/api/v1/support/tickets', { categoryId: cat(code), description: text, bookingId })
            .expect(201)
        ).body as { id: string }
      ).id;
    await ticket(0, act1, 'WORKER_CONDUCT', 'Worker arrived 30 minutes late today.');
    const t2 = await ticket(3, doneIds[1], 'PAYMENT_ISSUE', 'Need a copy of my payment receipt.');
    await a.post(`/api/v1/admin/support/tickets/${t2}/assign`, {}).expect(200);
    const t3 = await ticket(4, doneIds[2], 'OTHER', 'Feedback about the service quality.');
    await a.post(`/api/v1/admin/support/tickets/${t3}/assign`, {}).expect(200);
    await a.post(`/api/v1/admin/support/tickets/${t3}/close`, { resolution: 'Feedback noted and shared.' }).expect(200);

    log('bookings: matched/scheduled/interviewed/pending-payment/confirmed/active/completed+rated/cancelled/replacement; tickets OPEN/IN_PROGRESS/CLOSED');
    log(
      'row counts: ' +
        JSON.stringify({
          users: await api.prisma.user.count(),
          workers: await api.prisma.workerProfile.count(),
          bookings: await api.prisma.booking.count(),
          payments: await api.prisma.payment.count(),
          ratings: await api.prisma.rating.count(),
          tickets: await api.prisma.supportTicket.count(),
          attendance: await api.prisma.attendanceRecord.count(),
          audit: await api.prisma.auditLog.count(),
        }),
    );
  } finally {
    await api.close();
  }
}

main().catch((e: unknown) => {
  console.error('Demo seed failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
