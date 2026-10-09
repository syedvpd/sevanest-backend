import '../support/env-api-integration';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ApiApp, bearer, createApiApp, loginAdmin, loginWithOtp, unique } from '../support/api-app';
import {
  approveCheck,
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
} from '../support/workforce';

const SRC = join(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('Module boundaries (static)', () => {
  const files = sourceFiles(join(SRC, 'modules'));
  const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
  const moduleOf = (file: string) => relative(join(SRC, 'modules'), file).split(/[\\/]/)[0];

  it('only depends on modules in the allowed direction', () => {
    // module -> modules it may import (everything else is forbidden). Users never imports a business module.
    const allowed: Record<string, string[]> = {
      users: [],
      auth: ['users'],
      customers: ['users'],
      'service-categories': ['users'],
      workers: ['users', 'service-categories'],
      availability: ['users', 'workers'],
      verification: ['users', 'workers'],
      search: ['service-categories', 'availability', 'verification'],
      matching: ['search', 'availability', 'users'],
      booking: ['users', 'workers', 'service-categories', 'availability', 'search'],
      payment: ['booking', 'users'],
      notifications: ['users', 'auth'],
      attendance: ['booking', 'users', 'workers'],
      replacement: ['booking', 'matching', 'users', 'workers'],
      ratings: ['booking', 'users', 'workers'],
      support: ['booking', 'users', 'workers'],
      // Reports read other modules' tables with SELECTs only; the sole code it imports is Verification's SQL definition of "verified" and Users (permissions).
      reports: ['verification', 'users'],
    };
    const violations: string[] = [];
    for (const [file, content] of text) {
      const owner = moduleOf(file);
      for (const match of content.matchAll(/from '(?:\.\.\/)+([a-z-]+)\/[^']*'/g)) {
        const target = match[1];
        if (
          target !== owner &&
          Object.keys(allowed).includes(target) &&
          !allowed[owner].includes(target)
        ) {
          violations.push(`${relative(SRC, file)} imports ${target}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('touches each Prisma table only inside its owning module', () => {
    const owners: Record<string, string> = {
      user: 'users',
      role: 'users',
      permission: 'users',
      userRole: 'users',
      rolePermission: 'users',
      session: 'auth',
      deviceToken: 'auth',
      customerProfile: 'customers',
      customerAddress: 'customers',
      customerNote: 'customers',
      serviceCategory: 'service-categories',
      workerProfile: 'workers',
      workerSkill: 'workers',
      workerLanguage: 'workers',
      serviceArea: 'availability',
      workerWorkPreference: 'availability',
      workerPreferredArea: 'availability',
      workerTimeWindow: 'availability',
      verificationRequirement: 'verification',
      workerVerificationCheck: 'verification',
      workerVerificationEvent: 'verification',
      verificationDocument: 'verification',
      booking: 'booking',
      bookingEvent: 'booking',
      feeConfig: 'payment',
      payment: 'payment',
      paymentEvent: 'payment',
      notificationTemplate: 'notifications',
      notification: 'notifications',
      outboxEvent: 'common',
      attendanceRecord: 'attendance',
      attendanceEvent: 'attendance',
      replacementRequest: 'replacement',
      rating: 'ratings',
      workerRatingSummary: 'ratings',
      supportCategory: 'support',
      supportTicket: 'support',
      supportTicketEvent: 'support',
    };
    const violations: string[] = [];
    for (const [file, content] of text) {
      const owner = moduleOf(file);
      for (const [model, home] of Object.entries(owners)) {
        if (
          home !== owner &&
          new RegExp(`\\.${model}\\.(find|create|update|delete|upsert|count|aggregate)`).test(
            content,
          )
        ) {
          violations.push(`${relative(SRC, file)} accesses ${model} (owned by ${home})`);
        }
      }
    }
    // Auth's foundation guards read users/roles through the foundation AuthRepository; that predates Module 2 and is read-only.
    expect(
      violations.filter(
        (v) =>
          !v.startsWith('modules\\auth\\auth.repository') &&
          !v.startsWith('modules/auth/auth.repository'),
      ),
    ).toEqual([]);
  });

  it('keeps Search and Matching read-only: no Prisma model access and no statement that writes', () => {
    for (const [file, content] of text) {
      if (!['search', 'matching'].includes(moduleOf(file))) continue;
      const code = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP|ALTER)\b/i.test(code),
      ).toBe(false);
      expect(/\.\$(executeRaw|executeRawUnsafe|transaction)\b/.test(code)).toBe(false);
      // Only the Search repository talks to the database, and only through parameterised raw SELECTs.
      if (!file.endsWith('search.repository.ts')) {
        expect(/PrismaService|prisma\./i.test(code)).toBe(false);
      }
    }
  });

  it('keeps Reports read-only: no Prisma model access, no writing statement, only the READ ONLY transaction helper', () => {
    for (const [file, content] of text) {
      if (moduleOf(file) !== 'reports') continue;
      const code = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE|DROP|ALTER|CREATE\s+(TABLE|INDEX))\b/i.test(
          code,
        ),
      ).toBe(false);
      expect(/\.\$executeRawUnsafe|\.\$queryRawUnsafe/.test(code)).toBe(false);
      // The only statement executed with $executeRaw is the one that turns the transaction READ ONLY.
      const executes = [...code.matchAll(/\$executeRaw`([^`]*)`/g)].map((m) => m[1].trim());
      expect(executes.every((sql) => sql === 'SET TRANSACTION READ ONLY')).toBe(true);
      if (!file.endsWith('reports.repository.ts')) {
        expect(/PrismaService|prisma\./i.test(code)).toBe(false);
      }
    }
  });

  it('shares ONE definition of "verified": Search embeds the Verification fragment instead of re-implementing it', () => {
    const search = [...text.entries()].find(([f]) => f.endsWith('search.repository.ts'))![1];
    expect(search).toContain('verifiedWorkerCondition');
    expect(search).not.toMatch(/worker_verification_checks|verification_requirements/);
  });

  it('keeps KYC/document concerns out of Workers, Categories and Availability', () => {
    const offenders = [...text.entries()]
      .filter(([file]) =>
        ['workers', 'service-categories', 'availability'].includes(moduleOf(file)),
      )
      .filter(([, content]) =>
        /aadhaar|kyc[A-Za-z]*\s*[:=(]|verificationDocument|STORAGE_PROVIDER/i.test(
          content.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''),
        ),
      )
      .map(([file]) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe('Workforce journey and contract (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
  });
  afterAll(async () => {
    await api.close();
  });

  it('lets a worker onboard end to end while a customer can only read categories and areas', async () => {
    const worker = await loginWithOtp(api, { appType: 'WORKER' });
    const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
    const call = (
      who: { accessToken: string },
      method: 'get' | 'post' | 'patch' | 'put',
      url: string,
      body?: object,
    ) => api.http()[method](url).set('Authorization', bearer(who)).send(body);

    // Reference data is readable by both app types.
    const categories = await call(customer, 'get', '/api/v1/service-categories?limit=100');
    const cook = (categories.body.data as Array<{ id: string; code: string }>).find(
      (c) => c.code === 'COOK',
    )!;
    const area = (
      await call(admin, 'post', '/api/v1/admin/service-areas', {
        name: `Area ${unique()}`,
        city: `City ${unique()}`,
      })
    ).body as { id: string; city: string };
    const areas = await call(
      customer,
      'get',
      `/api/v1/service-areas?city=${encodeURIComponent(area.city)}`,
    );
    expect(areas.body.data).toHaveLength(1);

    // The customer cannot write reference data or touch any worker endpoint.
    for (const res of [
      await call(customer, 'post', '/api/v1/admin/service-categories', {
        code: 'HACK',
        name: 'Hack',
      }),
      await call(customer, 'post', '/api/v1/admin/service-areas', { name: 'Hack', city: 'Hack' }),
      await call(customer, 'post', '/api/v1/workers/me', { name: 'Ramesh Kumar' }),
      await call(customer, 'get', '/api/v1/workers/me/availability'),
      await call(customer, 'get', '/api/v1/admin/workers'),
    ]) {
      expect(res.status).toBe(403);
    }

    // The worker onboards: profile, roles, availability, submit.
    await call(worker, 'post', '/api/v1/workers/me', { name: 'Ramesh Kumar' }).expect(201);
    await call(worker, 'patch', '/api/v1/workers/me', {
      address: { line: '1 Main Rd', area: 'Madhapur', city: 'Hyderabad', pincode: '500081' },
      emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
      languages: ['en', 'hi'],
      experienceMonths: 36,
      expectedSalary: 18000,
    }).expect(200);
    await call(worker, 'put', '/api/v1/workers/me/categories', { categoryIds: [cook.id] }).expect(
      200,
    );
    await call(worker, 'patch', '/api/v1/workers/me/availability', {
      engagementPreference: 'PART_TIME',
      areaIds: [area.id],
      timeWindows: [{ start: '07:00', end: '11:00' }],
    }).expect(200);
    const submitted = await call(worker, 'post', '/api/v1/workers/me/submit');
    expect(submitted.status).toBe(200);
    expect(submitted.body.onboardingStatus).toBe('SUBMITTED');

    // The admin sees it all, including availability, through separate module endpoints.
    const workerId = submitted.body.id as string;
    const detail = await call(admin, 'get', `/api/v1/admin/workers/${workerId}`);
    expect(detail.body).toMatchObject({
      onboardingStatus: 'SUBMITTED',
      mobile: worker.mobile,
      categories: [expect.objectContaining({ code: 'COOK' })],
    });
    const availability = await call(admin, 'get', `/api/v1/admin/workers/${workerId}/availability`);
    expect(availability.body).toMatchObject({
      engagementPreference: 'PART_TIME',
      timeWindows: [{ start: '07:00', end: '11:00' }],
    });

    // Suspension ends the worker's access everywhere and leaves the data intact.
    await call(admin, 'patch', `/api/v1/admin/users/${worker.userId}/status`, {
      status: 'SUSPENDED',
    }).expect(200);
    await call(worker, 'get', '/api/v1/workers/me').expect(401);
    await call(worker, 'patch', '/api/v1/workers/me/availability', {
      engagementPreference: 'FULL_TIME',
    }).expect(401);
    expect((await call(admin, 'get', `/api/v1/admin/workers/${workerId}`)).body.accountStatus).toBe(
      'SUSPENDED',
    );

    // One audit trail across the three modules.
    const actions = (
      await api.prisma.auditLog.findMany({
        where: { OR: [{ entityId: workerId }, { entityId: area.id }, { entityId: worker.userId }] },
        select: { action: true },
      })
    ).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'worker.profile_create',
        'worker.profile_update',
        'worker.categories_set',
        'availability.update',
        'worker.profile_submit',
        'service_area.create',
        'user.status_change',
      ]),
    );
  });

  it('takes a worker from sign-up to being found by a customer and an administrator, and out again on re-check', async () => {
    const area = await createArea(api, admin);
    await setRequiredChecks(api, admin, ['IDENTITY', 'EMERGENCY_CONTACT']);
    try {
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const worker = await onboardWorker(api, { areaIds: [area.id], experienceMonths: 48 });
      const query = `category=HOUSE_MAID&areaId=${area.id}`;
      const found = async (): Promise<string[]> =>
        (
          (await as(api, customer).get(`/api/v1/search/workers?${query}`)).body as {
            data: Array<{ workerId: string }>;
          }
        ).data.map((c) => c.workerId);
      const matched = async (): Promise<string[]> =>
        (
          (
            await as(api, admin).post('/api/v1/admin/matching/candidates', {
              category: 'HOUSE_MAID',
              areaId: area.id,
              engagement: 'PART_TIME',
              availableFrom: '09:00',
              availableTo: '12:00',
            })
          ).body as { data: Array<{ workerId: string }> }
        ).data.map((c) => c.workerId);

      // Submitted, but no check done yet: invisible to both.
      expect(await found()).toEqual([]);
      expect(await matched()).toEqual([]);
      const identityId = await approveCheck(api, admin, worker, 'IDENTITY');
      expect(await found()).toEqual([]);
      await approveCheck(api, admin, worker, 'EMERGENCY_CONTACT');
      expect(await found()).toEqual([worker.workerId]);
      expect(await matched()).toEqual([worker.workerId]);
      expect((await as(api, worker).get('/api/v1/workers/me/verification')).body.level).toBe(
        'VERIFIED',
      );

      await as(api, admin)
        .post(`/api/v1/admin/verification/checks/${identityId}/recheck`, { remarks: 'Re-verify' })
        .expect(200);
      expect(await found()).toEqual([]);
      expect(await matched()).toEqual([]);
    } finally {
      await setRequiredChecks(api, admin, []);
    }
  });

  describe('OpenAPI', () => {
    type Operation = { security?: unknown[] };
    let spec: {
      paths: Record<string, Record<string, Operation>>;
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };

    beforeAll(async () => {
      spec = (await api.http().get('/docs/openapi.json')).body as typeof spec;
    });

    it('documents every Workers, Categories and Availability operation as bearer-protected', () => {
      const expected: Array<[string, string]> = [
        ['post', '/api/v1/workers/me'],
        ['get', '/api/v1/workers/me'],
        ['patch', '/api/v1/workers/me'],
        ['put', '/api/v1/workers/me/categories'],
        ['post', '/api/v1/workers/me/submit'],
        ['get', '/api/v1/admin/workers'],
        ['get', '/api/v1/admin/workers/{workerId}'],
        ['patch', '/api/v1/admin/workers/{workerId}'],
        ['put', '/api/v1/admin/workers/{workerId}/categories'],
        ['get', '/api/v1/service-categories'],
        ['get', '/api/v1/service-categories/{categoryId}'],
        ['get', '/api/v1/admin/service-categories'],
        ['get', '/api/v1/admin/service-categories/{categoryId}'],
        ['post', '/api/v1/admin/service-categories'],
        ['patch', '/api/v1/admin/service-categories/{categoryId}'],
        ['get', '/api/v1/service-areas'],
        ['get', '/api/v1/service-areas/{areaId}'],
        ['get', '/api/v1/admin/service-areas'],
        ['get', '/api/v1/admin/service-areas/{areaId}'],
        ['post', '/api/v1/admin/service-areas'],
        ['patch', '/api/v1/admin/service-areas/{areaId}'],
        ['get', '/api/v1/workers/me/availability'],
        ['patch', '/api/v1/workers/me/availability'],
        ['get', '/api/v1/admin/workers/{workerId}/availability'],
        ['patch', '/api/v1/admin/workers/{workerId}/availability'],
        ['get', '/api/v1/search/workers'],
        ['post', '/api/v1/admin/matching/candidates'],
        ['get', '/api/v1/workers/me/verification'],
        ['post', '/api/v1/workers/me/verification/checks/{checkType}/documents'],
        ['post', '/api/v1/workers/me/verification/documents/{documentId}/confirm'],
        ['post', '/api/v1/workers/me/verification/checks/{checkType}/submit'],
        ['get', '/api/v1/admin/verification/queue'],
        ['get', '/api/v1/admin/verification/requirements'],
        ['put', '/api/v1/admin/verification/requirements'],
        ['post', '/api/v1/admin/verification/checks/{checkId}/start-review'],
        ['post', '/api/v1/admin/verification/checks/{checkId}/approve'],
        ['post', '/api/v1/admin/verification/checks/{checkId}/reject'],
        ['post', '/api/v1/admin/verification/checks/{checkId}/recheck'],
        ['get', '/api/v1/admin/verification/documents/{documentId}/link'],
        ['get', '/api/v1/admin/workers/{workerId}/verification'],
        ['post', '/api/v1/bookings'],
        ['get', '/api/v1/bookings/{bookingId}'],
        ['post', '/api/v1/bookings/{bookingId}/{action}'],
        ['get', '/api/v1/workers/me/bookings'],
        ['post', '/api/v1/workers/me/bookings/{bookingId}/{action}'],
        ['get', '/api/v1/admin/bookings'],
        ['post', '/api/v1/admin/bookings/{bookingId}/{action}'],
        ['post', '/api/v1/payments'],
        ['post', '/api/v1/payments/{paymentId}/verify'],
        ['get', '/api/v1/payments'],
        ['get', '/api/v1/admin/payments'],
        ['post', '/api/v1/admin/payments/{paymentId}/refund'],
        ['put', '/api/v1/admin/fees/booking-fee'],
        ['get', '/api/v1/admin/notification-templates'],
        ['post', '/api/v1/admin/notification-templates'],
        ['get', '/api/v1/admin/notifications'],
        ['post', '/api/v1/workers/me/attendance/bookings/{bookingId}'],
        ['get', '/api/v1/attendance/bookings/{bookingId}'],
        ['post', '/api/v1/attendance/bookings/{bookingId}/exceptions'],
        ['patch', '/api/v1/admin/attendance/{attendanceId}'],
        ['post', '/api/v1/replacement-requests'],
        ['post', '/api/v1/replacement-requests/{requestId}/select'],
        ['post', '/api/v1/admin/replacement-requests/{requestId}/approve'],
      ];
      for (const [method, path] of expected) {
        expect(spec.paths[path]?.[method]).toBeDefined();
        expect(spec.paths[path][method].security).toEqual([{ bearer: [] }]);
      }
    });

    it('exposes only client-writable fields in request schemas and no private fields in responses', () => {
      const props = (name: string) =>
        Object.keys(
          (spec.components.schemas[name] ?? { properties: { [`MISSING_${name}`]: 1 } })
            .properties ?? {},
        ).sort();
      expect(props('CreateWorkerProfileDto')).toEqual(['name']);
      expect(props('UpdateWorkerProfileDto')).toEqual([
        'address',
        'emergencyContact',
        'expectedSalary',
        'experienceMonths',
        'languages',
        'name',
        'previousEmployer',
      ]);
      expect(props('UpdateAvailabilityDto')).toEqual([
        'areaIds',
        'engagementPreference',
        'timeWindows',
      ]);
      expect(props('UpdateServiceCategoryDto')).toEqual(['description', 'isEnabled', 'name']);
      expect(props('UpdateServiceAreaDto')).toEqual(['city', 'isEnabled', 'name']);
      expect(props('SetWorkerCategoriesDto')).toEqual(['categoryIds']);
      expect(props('RequestDocumentUploadDto')).toEqual(['contentType', 'sizeBytes']);
      expect(props('ApproveCheckDto')).toEqual(['recheckAt', 'remarks']);
      expect(props('RemarksDto')).toEqual(['remarks']);
      expect(props('SetRequirementsDto')).toEqual(['checkTypes']);
      expect(props('MatchRequirementDto')).toEqual(
        [
          'areaId',
          'availableFrom',
          'availableTo',
          'category',
          'engagement',
          'language',
          'limit',
          'minExperienceMonths',
          'page',
        ].sort(),
      );
      // The customer-facing card is an exact allow-list; the document view carries no storage key.
      expect(props('WorkerCard')).toEqual(
        [
          'availability',
          'categories',
          'engagementPreference',
          'experienceMonths',
          'languages',
          'serviceAreas',
          'verification',
          'workerId',
        ].sort(),
      );
      expect(props('DocumentView')).toEqual(
        ['contentType', 'createdAt', 'id', 'sizeBytes', 'status', 'submitted'].sort(),
      );
      for (const name of Object.keys(spec.components.schemas).filter((n) =>
        /Response|Summary|Detail|Ref$/.test(n),
      )) {
        expect(
          props(name).filter((p) =>
            /photoRef|profilePhotoRef|kyc|password|hash|otp|objectKey|storageKey/i.test(p),
          ),
        ).toEqual([]);
      }
    });
  });
});
