/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return -- measurement tooling: response bodies are read loosely on purpose */
import '../support/env-api-integration';
// Tokens must outlive the run; throttles are lifted so a single-user sequential run is never limited.
process.env.JWT_ACCESS_TTL_SECONDS = '28800';

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { AddressInfo } from 'node:net';
import {
  ApiApp,
  createAdmin,
  createApiApp,
  otpFromSms,
  randomIp,
  randomMobile,
  unique,
} from '../support/api-app';
import { fakeGateway, inDays, makeBooking } from '../support/bookings';
import { SAMPLE_JPEG } from '../support/images';
import { DEFAULT_IN_APP_TEMPLATES } from '../../src/modules/notifications/default-templates';
import { NotificationsRepository } from '../../src/modules/notifications/notifications.repository';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import {
  approveCheck,
  categoryId,
  checkIdOf,
  onboardWorker,
  uploadDocument,
} from '../support/workforce';

/**
 * Whole-backend performance run (NOT a load test): one client, strictly sequential. Every iteration walks each module through its
 * lifecycle in the natural order (create, read, list, update, state changes, delete) against real HTTP on a real port, and every
 * call is timed. Iteration 1 is the "first hit" (cold), iteration 2 the "second hit", all iterations feed p50/p95/p99.
 * Not part of the normal suites (the name does not match the integration pattern). Run with
 *   PERF_ITERATIONS=15 jest --config test/jest-integration.config.js --testRegex "perf/.*\.perf-journeys\.perf-spec\.ts$" --runInBand
 * Only a disposable *_ci database is accepted (guard in env-api-integration).
 */
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 15);

interface Sample {
  method: string;
  template: string;
  ms: number[];
  statuses: Record<number, number>;
  unexpected: Record<number, string>;
}
const samples = new Map<string, Sample>();
const skipped = new Set<string>();

type Hit = { status: number; body: any; ms: number };
type Sess = { token: string; refresh: string; userId: string; mobile?: string };

describe('Performance journeys', () => {
  let api: ApiApp;
  let base = '';

  const hit = async (
    method: string,
    template: string,
    o: {
      p?: Record<string, string | undefined>;
      q?: string;
      t?: string | null;
      body?: unknown;
      ok?: number[];
      h?: Record<string, string>;
    } = {},
  ): Promise<Hit> => {
    const path = template.replace(/\{(\w+)\}/g, (_m, k: string) => String(o.p?.[k] ?? 'MISSING'));
    const url = `${base}${template.startsWith('/health') ? '' : '/api/v1'}${path}${o.q ? `?${o.q}` : ''}`;
    const headers: Record<string, string> = { 'x-forwarded-for': randomIp(), ...(o.h ?? {}) };
    if (o.t) headers.authorization = `Bearer ${o.t}`;
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    const started = performance.now();
    const res = await fetch(url, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    let body: any;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 80) };
    }
    const key = `${method} ${template}`;
    const s = samples.get(key) ?? { method, template, ms: [], statuses: {}, unexpected: {} };
    s.ms.push(ms);
    s.statuses[res.status] = (s.statuses[res.status] ?? 0) + 1;
    const ok = o.ok ?? [200, 201, 202, 204];
    if (!ok.includes(res.status) && !s.unexpected[res.status])
      s.unexpected[res.status] = text.slice(0, 160);
    samples.set(key, s);
    return { status: res.status, body, ms };
  };

  const otpLogin = async (appType: 'CUSTOMER' | 'WORKER'): Promise<Sess> => {
    const mobile = randomMobile();
    const ip = randomIp();
    await hit('POST', '/auth/otp/request', {
      body: { mobile, appType },
      h: { 'x-forwarded-for': ip },
    });
    const v = await hit('POST', '/auth/otp/verify', {
      body: { mobile, appType, otp: otpFromSms(api, mobile), deviceId: `perf-${unique()}` },
      h: { 'x-forwarded-for': ip },
    });
    return {
      token: v.body.accessToken,
      refresh: v.body.refreshToken,
      userId: v.body.user.id,
      mobile,
    };
  };
  const need = (label: string, ...values: unknown[]): boolean => {
    if (values.every((v) => v !== undefined && v !== null && v !== 'MISSING')) return true;
    skipped.add(label);
    return false;
  };

  beforeAll(async () => {
    api = await createApiApp();
    // the starter in-app wording a real deployment gets from `npm run seed:launch`, so lifecycle events produce notifications
    const templates = new NotificationsRepository(api.prisma);
    for (const t of DEFAULT_IN_APP_TEMPLATES) {
      await templates.upsertDefaultTemplate({
        eventCode: t.event,
        channel: 'IN_APP',
        language: 'en',
        title: t.title,
        body: t.body,
      });
    }
    await api.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(api.app.getHttpServer() as { address(): AddressInfo }).address().port}`;
  });
  afterAll(async () => {
    await api.close();
  });

  const iteration = async (i: number): Promise<void> => {
    // ------------------------------------------------------------------ platform (public)
    await hit('GET', '/health/live');
    await hit('GET', '/health/ready');
    await hit('GET', '/app-config');
    await hit('GET', '/reference-data');

    // ------------------------------------------------------------------ admin: sign in, accounts, access control
    const adminUser = await createAdmin(api);
    const login = await hit('POST', '/auth/admin/login', {
      body: { email: adminUser.email, password: adminUser.password },
    });
    const A = login.body.accessToken as string;
    await hit('GET', '/users/me', { t: A });
    const newAdmin = await hit('POST', '/admin/users', {
      t: A,
      body: {
        email: `perf.${unique()}@example.test`,
        password: 'a-long-enough-password-1!',
        roleCode: 'SUPPORT_EXECUTIVE',
      },
    });
    const newAdminId = (newAdmin.body?.id ?? newAdmin.body?.userId) as string | undefined;
    await hit('GET', '/admin/users', { t: A, q: 'limit=20' });
    if (need('admin user steps', newAdminId)) {
      await hit('GET', '/admin/users/{userId}', { t: A, p: { userId: newAdminId } });
      await hit('PUT', '/admin/users/{userId}/role', {
        t: A,
        p: { userId: newAdminId },
        body: { roleCode: 'OPERATIONS_ADMIN', reason: 'perf role change' },
      });
      await hit('POST', '/admin/users/{userId}/password-reset', {
        t: A,
        p: { userId: newAdminId },
      });
      await hit('PATCH', '/admin/users/{userId}/status', {
        t: A,
        p: { userId: newAdminId },
        body: { status: 'SUSPENDED', reason: 'perf' },
      });
    }
    const roles = await hit('GET', '/admin/roles', { t: A });
    await hit('GET', '/admin/permissions', { t: A });
    const support = (roles.body as Array<{ code: string; permissionCodes: string[] }>).find(
      (r) => r.code === 'SUPPORT_EXECUTIVE',
    );
    await hit('GET', '/admin/roles/{roleCode}', { t: A, p: { roleCode: 'SUPPORT_EXECUTIVE' } });
    if (support)
      await hit('PUT', '/admin/roles/{roleCode}/permissions', {
        t: A,
        p: { roleCode: 'SUPPORT_EXECUTIVE' },
        body: { permissionCodes: support.permissionCodes },
      });

    // ------------------------------------------------------------------ admin: catalogue and configuration (CRUD)
    const area = await hit('POST', '/admin/service-areas', {
      t: A,
      body: {
        name: `Perf Area ${unique()}`,
        city: 'Hyderabad',
        centerLatitude: 17.45,
        centerLongitude: 78.39,
        radiusMeters: 1500,
      },
    });
    const areaId = area.body?.id as string;
    await hit('GET', '/admin/service-areas', { t: A, q: 'limit=20' });
    if (need('area steps', areaId)) {
      await hit('GET', '/admin/service-areas/{areaId}', { t: A, p: { areaId } });
      await hit('PATCH', '/admin/service-areas/{areaId}', {
        t: A,
        p: { areaId },
        body: { radiusMeters: 2000 },
      });
    }
    const code = `PERF_${unique()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12)}`;
    const cat = await hit('POST', '/admin/service-categories', {
      t: A,
      body: { code, name: `Perf ${code}`, description: 'performance category' },
    });
    const catId = cat.body?.id as string;
    await hit('GET', '/admin/service-categories', { t: A, q: 'limit=20' });
    if (need('category steps', catId)) {
      await hit('GET', '/admin/service-categories/{categoryId}', {
        t: A,
        p: { categoryId: catId },
      });
      await hit('PATCH', '/admin/service-categories/{categoryId}', {
        t: A,
        p: { categoryId: catId },
        body: { description: 'updated' },
      });
      await hit('PUT', '/admin/service-categories/{categoryId}/engagements', {
        t: A,
        p: { categoryId: catId },
        body: { engagements: ['HOURLY', 'ONE_TIME'] },
      });
      const band = await hit('PUT', '/admin/pricing-guidance', {
        t: A,
        body: {
          category: code,
          engagement: 'HOURLY',
          minMinor: 20000,
          maxMinor: 40000,
          period: 'HOUR',
          basis: 'ESTIMATE',
        },
      });
      await hit('GET', '/admin/pricing-guidance', { t: A, q: `category=${code}` });
      if (need('delete pricing band', band.body?.id))
        await hit('DELETE', '/admin/pricing-guidance/{id}', { t: A, p: { id: band.body.id } });
    }
    await hit('GET', '/admin/fees', { t: A });
    await hit('PUT', '/admin/fees/booking-fee', {
      t: A,
      body: { amountMinor: 50000, isActive: true },
    });
    await hit('PUT', '/admin/fees/{code}', {
      t: A,
      p: { code: 'PERF_FEE' },
      body: { amountMinor: 1000, isActive: true },
    });
    await hit('GET', '/admin/verification/requirements', { t: A });
    await hit('PUT', '/admin/verification/requirements', {
      t: A,
      body: { checkTypes: ['IDENTITY'] },
    });
    const sc = await hit('POST', '/admin/support/categories', {
      t: A,
      body: {
        code: `PERF_${unique()
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 10)}`,
        name: 'Perf support',
      },
    });
    await hit('GET', '/admin/support/categories', { t: A });
    if (need('support category patch', sc.body?.id))
      await hit('PATCH', '/admin/support/categories/{categoryId}', {
        t: A,
        p: { categoryId: sc.body.id },
        body: { name: 'Perf support (edited)' },
      });
    const langs = [
      'hi',
      'te',
      'ta',
      'kn',
      'ml',
      'bn',
      'mr',
      'gu',
      'pa',
      'or',
      'as',
      'ur',
      'ne',
      'si',
      'sa',
      'fr',
      'de',
      'es',
      'it',
      'pt',
    ];
    const tpl = await hit('POST', '/admin/notification-templates', {
      t: A,
      body: {
        eventCode: 'BOOKING_CONFIRMED',
        channel: 'SMS',
        language: langs[i % langs.length],
        body: 'Booking confirmed for {{bookingId}}',
      },
    });
    await hit('GET', '/admin/notification-templates', { t: A, q: 'limit=20' });
    if (need('template steps', tpl.body?.id)) {
      await hit('GET', '/admin/notification-templates/{templateId}', {
        t: A,
        p: { templateId: tpl.body.id },
      });
      await hit('PATCH', '/admin/notification-templates/{templateId}', {
        t: A,
        p: { templateId: tpl.body.id },
        body: { body: 'Booking confirmed: {{bookingId}}' },
      });
    }

    // ------------------------------------------------------------------ customer: sign up, profile, addresses, sessions
    const cust = await otpLogin('CUSTOMER');
    const C = cust.token;
    await hit('GET', '/legal/current', { t: C });
    await hit('GET', '/legal/status', { t: C });
    await hit('POST', '/legal/accept', {
      t: C,
      body: { acceptTerms: true, acceptPrivacy: true },
      ok: [200, 201, 204, 400, 409, 422],
    });
    const profile = await hit('POST', '/customers/me', {
      t: C,
      body: {
        name: 'Perf Customer',
        email: `perf.${unique()}@example.test`,
        preferredLanguage: 'en',
      },
    });
    await hit('GET', '/customers/me', { t: C });
    await hit('PATCH', '/customers/me', { t: C, body: { name: 'Perf Customer Two' } });
    await hit('GET', '/customers/me/onboarding', { t: C });
    const addr = await hit('POST', '/customers/me/addresses', {
      t: C,
      body: {
        label: 'Home',
        line: '1 Main Rd',
        line2: 'Flat 4',
        area: area.body?.name ?? 'Madhapur',
        city: 'Hyderabad',
        state: 'Telangana',
        pincode: '500081',
        isDefault: true,
      },
    });
    const addressId = addr.body?.id as string;
    await hit('GET', '/customers/me/addresses', { t: C });
    if (need('address steps', addressId)) {
      await hit('GET', '/customers/me/addresses/{addressId}', { t: C, p: { addressId } });
      await hit('PATCH', '/customers/me/addresses/{addressId}', {
        t: C,
        p: { addressId },
        body: { line2: 'Flat 5' },
      });
      await hit('PUT', '/customers/me/addresses/{addressId}/default', { t: C, p: { addressId } });
      const second = await hit('POST', '/customers/me/addresses', {
        t: C,
        body: {
          label: 'Office',
          line: '9 Park Rd',
          area: area.body?.name ?? 'Madhapur',
          city: 'Hyderabad',
          state: 'Telangana',
          pincode: '500081',
        },
      });
      if (need('delete address', second.body?.id))
        await hit('DELETE', '/customers/me/addresses/{addressId}', {
          t: C,
          p: { addressId: second.body.id },
        });
    }
    const refreshed = await hit('POST', '/auth/token/refresh', {
      body: { refreshToken: cust.refresh },
    });
    const C2 = (refreshed.body?.accessToken as string) ?? C;
    const sessions = await hit('GET', '/auth/sessions', { t: C2 });
    await hit('PUT', '/auth/device-token', {
      t: C2,
      body: { token: `fcm-${unique()}-${unique()}-${unique()}`, platform: 'ANDROID' },
    });
    await hit('DELETE', '/auth/device-token', { t: C2 });
    await hit('GET', '/customers/me/home', { t: C2 });

    // ------------------------------------------------------------------ worker 1: registration, availability, KYC, photo (HTTP, timed)
    const w1 = await otpLogin('WORKER');
    const W1 = w1.token;
    const wp = await hit('POST', '/workers/me', { t: W1, body: { name: 'Perf Worker One' } });
    const worker1Id = wp.body?.id as string;
    await hit('PATCH', '/workers/me', {
      t: W1,
      body: {
        address: { line: '1 Main Rd', area: 'Madhapur', city: 'Hyderabad', pincode: '500081' },
        emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
        languages: ['en', 'hi'],
        experienceMonths: 36,
        expectedSalary: 18000,
      },
    });
    const houseMaidId = await categoryId(api, 'HOUSE_MAID');
    await hit('PUT', '/workers/me/categories', { t: W1, body: { categoryIds: [houseMaidId] } });
    await hit('PUT', '/workers/me/references', {
      t: W1,
      body: {
        references: [{ name: 'Mr Sharma', mobile: '9876511111', relationship: 'Neighbour' }],
      },
    });
    await hit('GET', '/workers/me/references', { t: W1 });
    if (need('availability steps', areaId)) {
      await hit('PATCH', '/workers/me/availability', {
        t: W1,
        body: {
          engagementPreference: 'PART_TIME',
          areaIds: [areaId],
          timeWindows: [{ start: '08:00', end: '14:00' }],
        },
      });
      await hit('GET', '/workers/me/availability', { t: W1 });
    }
    const photo = await hit('POST', '/workers/me/photo', {
      t: W1,
      body: { contentType: 'image/jpeg', sizeBytes: 5000 },
    });
    if (need('photo steps', photo.body?.photoId)) {
      api.storage.simulateUpload(api.storage.issuedUploads.at(-1)!.objectKey, 5000, SAMPLE_JPEG);
      await hit('POST', '/workers/me/photo/{photoId}/confirm', {
        t: W1,
        p: { photoId: photo.body.photoId },
      });
      await hit('GET', '/workers/me/photo', { t: W1 });
    }
    await hit('POST', '/workers/me/submit', { t: W1 });
    await hit('GET', '/workers/me/verification', { t: W1 });
    const doc = await hit('POST', '/workers/me/verification/checks/{checkType}/documents', {
      t: W1,
      p: { checkType: 'IDENTITY' },
      body: { contentType: 'application/pdf', sizeBytes: 2000 },
    });
    if (need('document steps', doc.body?.documentId)) {
      api.storage.simulateUpload(api.storage.issuedUploads.at(-1)!.objectKey, 2000);
      await hit('POST', '/workers/me/verification/documents/{documentId}/confirm', {
        t: W1,
        p: { documentId: doc.body.documentId },
      });
    }
    await hit('POST', '/workers/me/verification/checks/{checkType}/submit', {
      t: W1,
      p: { checkType: 'IDENTITY' },
    });
    await hit('GET', '/workers/me/onboarding', { t: W1 });
    await hit('GET', '/workers/me', { t: W1 });
    // staff verification
    await hit('GET', '/admin/verification/queue', { t: A, q: 'limit=20' });
    const wv = await hit('GET', '/admin/workers/{workerId}/verification', {
      t: A,
      p: { workerId: worker1Id },
    });
    const check = (
      wv.body?.checks as
        Array<{ checkType: string; checkId: string; documents?: Array<{ id: string }> }> | undefined
    )?.find((c) => c.checkType === 'IDENTITY');
    if (need('verification steps', check?.checkId)) {
      await hit('POST', '/admin/verification/checks/{checkId}/start-review', {
        t: A,
        p: { checkId: check!.checkId },
      });
      await hit('POST', '/admin/verification/checks/{checkId}/approve', {
        t: A,
        p: { checkId: check!.checkId },
        body: {},
      });
      if (check!.documents?.[0])
        await hit('GET', '/admin/verification/documents/{documentId}/link', {
          t: A,
          p: { documentId: check!.documents[0].id },
        });
    }
    await hit('GET', '/admin/workers', { t: A, q: 'limit=20' });
    await hit('POST', '/admin/workers', {
      t: A,
      body: {
        name: 'Perf Admin Worker',
        mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      },
    });
    await hit('GET', '/admin/workers/{workerId}', { t: A, p: { workerId: worker1Id } });
    await hit('PATCH', '/admin/workers/{workerId}', {
      t: A,
      p: { workerId: worker1Id },
      body: { experienceMonths: 40 },
    });
    await hit('PUT', '/admin/workers/{workerId}/categories', {
      t: A,
      p: { workerId: worker1Id },
      body: { categoryIds: [houseMaidId] },
    });
    await hit('GET', '/admin/workers/{workerId}/references', { t: A, p: { workerId: worker1Id } });
    await hit('GET', '/admin/workers/{workerId}/availability', {
      t: A,
      p: { workerId: worker1Id },
    });
    await hit('PATCH', '/admin/workers/{workerId}/availability', {
      t: A,
      p: { workerId: worker1Id },
      body: {
        engagementPreference: 'PART_TIME',
        areaIds: [areaId],
        timeWindows: [{ start: '08:00', end: '14:00' }],
      },
    });

    const w4 = await onboardWorker(api, { areaIds: [areaId] });
    await uploadDocument(api, w4, 'IDENTITY');
    await fetch(`${base}/api/v1/workers/me/verification/checks/IDENTITY/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${w4.accessToken}` },
    });
    const rejectId = await checkIdOf(api, { accessToken: A }, w4.workerId, 'IDENTITY').catch(
      () => undefined,
    );
    if (need('reject check', rejectId)) {
      await hit('POST', '/admin/verification/checks/{checkId}/start-review', {
        t: A,
        p: { checkId: rejectId },
      });
      await hit('POST', '/admin/verification/checks/{checkId}/reject', {
        t: A,
        p: { checkId: rejectId },
        body: { remarks: 'Perf: document unclear' },
      });
    }
    // ------------------------------------------------------------------ discovery and shortlist (customer)
    await hit('GET', '/service-categories', { t: C2, q: 'limit=50' });
    await hit('GET', '/pricing/guidance', {
      t: C2,
      q: `category=HOUSE_MAID&engagement=PART_TIME&areaId=${areaId}`,
      ok: [200, 404],
    });
    await hit('GET', '/service-categories/{categoryId}', { t: C2, p: { categoryId: houseMaidId } });
    await hit('GET', '/service-areas', { t: C2, q: 'limit=50' });
    await hit('GET', '/service-areas/{areaId}', { t: C2, p: { areaId } });
    await hit('GET', '/locations/service-area', { t: C2, q: 'latitude=17.45&longitude=78.39' });
    await hit('GET', '/search/workers', {
      t: C2,
      q: `category=HOUSE_MAID&areaId=${areaId}&limit=10`,
    });
    await hit('GET', '/search/workers/{workerId}', { t: C2, p: { workerId: worker1Id } });
    await hit('GET', '/search/workers/{workerId}/slots', {
      t: C2,
      p: { workerId: worker1Id },
      q: `date=${inDays(2)}`,
    });
    await hit('GET', '/search/workers/{workerId}/ratings', { t: C2, p: { workerId: worker1Id } });
    await hit('PUT', '/shortlist/{workerId}', { t: C2, p: { workerId: worker1Id } });
    await hit('GET', '/shortlist', { t: C2 });
    await hit('DELETE', '/shortlist/{workerId}', { t: C2, p: { workerId: worker1Id } });

    // ------------------------------------------------------------------ booking lifecycle with worker 1 (create, interview, pay, serve, complete, rate)
    const customerAsCaller = { accessToken: C2 };
    const booking = await hit('POST', '/bookings', {
      t: C2,
      body: {
        category: 'HOUSE_MAID',
        areaId,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
        workerId: worker1Id,
        addressId,
      },
    });
    const bookingId = booking.body?.id as string;
    if (need('booking lifecycle', bookingId)) {
      await hit('GET', '/bookings', { t: C2 });
      await hit('GET', '/bookings/{bookingId}', { t: C2, p: { bookingId } });
      await hit('GET', '/workers/me/opportunities', { t: W1 });
      await hit('GET', '/workers/me/bookings', { t: W1 });
      await hit('GET', '/workers/me/bookings/{bookingId}', { t: W1, p: { bookingId } });
      await hit('POST', '/workers/me/bookings/{bookingId}/{action}', {
        t: W1,
        p: { bookingId, action: 'accept' },
        body: {},
      });
      const iv = await hit('POST', '/interviews', {
        t: C2,
        body: {
          bookingId,
          type: 'INTERVIEW',
          preferredAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
      });
      const interviewId = iv.body?.id as string;
      await hit('GET', '/interviews', { t: C2 });
      await hit('GET', '/bookings/{bookingId}/interviews', { t: C2, p: { bookingId } });
      if (need('interview steps', interviewId)) {
        await hit('GET', '/interviews/{interviewId}', { t: C2, p: { interviewId } });
        await hit('GET', '/workers/me/interviews', { t: W1 });
        await hit('GET', '/workers/me/interviews/{interviewId}', { t: W1, p: { interviewId } });
        await hit('POST', '/workers/me/interviews/{interviewId}/accept', {
          t: W1,
          p: { interviewId },
          body: {},
        });
        await hit('POST', '/workers/me/interviews/{interviewId}/propose', {
          t: W1,
          p: { interviewId },
          body: { proposedAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), note: 'later' },
        });
        await hit('POST', '/interviews/{interviewId}/reject-proposal', {
          t: C2,
          p: { interviewId },
          body: {},
        });
        await hit('POST', '/interviews/{interviewId}/reschedule', {
          t: C2,
          p: { interviewId },
          body: { preferredAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), note: 'perf' },
        });
        await hit('POST', '/workers/me/interviews/{interviewId}/propose', {
          t: W1,
          p: { interviewId },
          body: { proposedAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
        });
        await hit('POST', '/interviews/{interviewId}/accept-proposal', {
          t: C2,
          p: { interviewId },
          body: {},
        });
        await hit('POST', '/interviews/{interviewId}/complete', {
          t: C2,
          p: { interviewId },
          body: { outcomeNote: 'Good fit' },
        });
      }
      // booking state machine through the generic action route
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId, action: 'schedule' },
        body: {
          scheduleType: 'INTERVIEW',
          scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        ok: [200, 409],
      });
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId, action: 'interview-complete' },
        body: { outcomeNote: 'ok' },
        ok: [200, 409],
      });
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId, action: 'confirm-worker' },
        body: { startDate: inDays(0) },
        ok: [200, 409],
      });
      // payment
      await hit('GET', '/ratings/bookings/{bookingId}/eligibility', { t: C2, p: { bookingId } });
      const pay = await hit('POST', '/payments', { t: C2, body: { bookingId } });
      const paymentId = pay.body?.id as string;
      if (need('payment steps', paymentId)) {
        await hit('GET', '/payments/{paymentId}', { t: C2, p: { paymentId } });
        await hit('GET', '/payments', { t: C2, q: `bookingId=${bookingId}` });
        await hit('GET', '/payments/{paymentId}/receipt', {
          t: C2,
          p: { paymentId },
          ok: [200, 409],
        });
        const done = fakeGateway(api).completeCheckout(pay.body.checkout.orderId, 'SUCCEEDED');
        await hit('POST', '/payments/{paymentId}/verify', {
          t: C2,
          p: { paymentId },
          body: { providerPaymentId: done.providerPaymentId, signature: done.signature },
        });
        await hit('GET', '/payments/{paymentId}/receipt', { t: C2, p: { paymentId } });
        await hit('GET', '/payments/{paymentId}/receipt/pdf', { t: C2, p: { paymentId } });
      }
      // service starts: attendance
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId, action: 'start' },
        body: {},
      });
      await api.prisma.booking.update({
        where: { id: bookingId },
        data: { startDate: new Date(Date.now() - 4 * 86_400_000) },
      });
      await hit('POST', '/workers/me/attendance/bookings/{bookingId}/check-in', {
        t: W1,
        p: { bookingId },
      });
      await hit('POST', '/workers/me/attendance/bookings/{bookingId}/check-out', {
        t: W1,
        p: { bookingId },
      });
      await hit('GET', '/workers/me/attendance/bookings/{bookingId}', { t: W1, p: { bookingId } });
      const month = new Date().toISOString().slice(0, 7);
      await hit('GET', '/workers/me/attendance/bookings/{bookingId}/summary', {
        t: W1,
        p: { bookingId },
        q: `month=${month}`,
      });
      await hit('POST', '/workers/me/attendance/bookings/{bookingId}', {
        t: W1,
        p: { bookingId },
        body: { status: 'PRESENT' },
        ok: [200, 201],
      });
      await hit('GET', '/attendance/bookings/{bookingId}', { t: C2, p: { bookingId } });
      await hit('GET', '/attendance/bookings/{bookingId}/summary', {
        t: C2,
        p: { bookingId },
        q: `month=${month}`,
      });
      const ex = await hit('POST', '/attendance/bookings/{bookingId}/exceptions', {
        t: C2,
        p: { bookingId },
        body: {
          date: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
          note: 'Not recorded by the worker',
        },
      });
      await hit('POST', '/admin/attendance/bookings/{bookingId}', {
        t: A,
        p: { bookingId },
        body: {
          date: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10),
          status: 'LEAVE',
          note: 'Approved leave',
        },
      });
      await hit('GET', '/admin/attendance/bookings/{bookingId}', { t: A, p: { bookingId } });
      await hit('GET', '/admin/attendance/bookings/{bookingId}/summary', {
        t: A,
        p: { bookingId },
        q: `month=${month}`,
      });
      if (need('attendance correction', ex.body?.id))
        await hit('PATCH', '/admin/attendance/{attendanceId}', {
          t: A,
          p: { attendanceId: ex.body.id },
          body: { status: 'ABSENT', reason: 'Checked with the worker' },
        });
      // completion, rating, history, rebook
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId, action: 'complete' },
        body: {},
      });
      await hit('GET', '/ratings/bookings/{bookingId}/eligibility', { t: C2, p: { bookingId } });
      const rating = await hit('POST', '/ratings', {
        t: C2,
        body: { bookingId, score: 5, review: 'Very good service' },
      });
      await hit('GET', '/ratings', { t: C2 });
      await hit('GET', '/ratings/bookings/{bookingId}', { t: C2, p: { bookingId } });
      if (need('rating steps', rating.body?.id)) {
        await hit('GET', '/ratings/{ratingId}', { t: C2, p: { ratingId: rating.body.id } });
        await hit('GET', '/admin/ratings', { t: A, q: 'limit=20' });
        await hit('GET', '/admin/ratings/{ratingId}', { t: A, p: { ratingId: rating.body.id } });
        await hit('POST', '/admin/ratings/{ratingId}/hide', {
          t: A,
          p: { ratingId: rating.body.id },
          body: { reason: 'perf moderation' },
        });
        await hit('POST', '/admin/ratings/{ratingId}/unhide', {
          t: A,
          p: { ratingId: rating.body.id },
          body: { reason: 'perf moderation' },
        });
      }
      await hit('GET', '/admin/ratings/workers/{workerId}/summary', {
        t: A,
        p: { workerId: worker1Id },
      });
      await hit('GET', '/workers/me/ratings', { t: W1 });
      await hit('GET', '/workers/me/ratings/summary', { t: W1 });
      await hit('GET', '/customers/me/booking-history', { t: C2 });
      await hit('GET', '/customers/me/booking-history/summary', { t: C2 });
      await hit('GET', '/bookings/{bookingId}/replacement-chain', { t: C2, p: { bookingId } });
      await hit('POST', '/bookings/rebook', {
        t: C2,
        body: { bookingId },
        ok: [200, 201, 409, 422],
      });

      // admin views of the same data
      await hit('GET', '/admin/bookings', { t: A, q: 'limit=20' });
      await hit('GET', '/admin/bookings/{bookingId}', { t: A, p: { bookingId } });
      await hit('GET', '/admin/bookings/{bookingId}/replacement-chain', { t: A, p: { bookingId } });
      await hit('GET', '/admin/bookings/{bookingId}/interviews', { t: A, p: { bookingId } });
      await hit('GET', '/admin/interviews', { t: A, q: 'limit=20' });
      if (need('admin interview detail', interviewId))
        await hit('GET', '/admin/interviews/{interviewId}', { t: A, p: { interviewId } });
      if (need('admin payment steps', paymentId)) {
        await hit('GET', '/admin/payments', { t: A, q: 'limit=20' });
        await hit('GET', '/admin/payments/{paymentId}', { t: A, p: { paymentId } });
        await hit('POST', '/admin/payments/{paymentId}/reconcile', {
          t: A,
          p: { paymentId },
          ok: [200, 409, 422],
        });
        await hit('GET', '/admin/payments-export', {
          t: A,
          q: `from=${inDays(-30)}&to=${inDays(1)}`,
        });
        await hit('POST', '/admin/payments/{paymentId}/refund', {
          t: A,
          p: { paymentId },
          body: { reason: 'perf refund' },
        });
      }
    }
    await hit('GET', '/admin/payment-exceptions', { t: A });
    await hit('GET', '/admin/payment-recovery/summary', { t: A });

    // ------------------------------------------------------------------ booking 2 (admin-created) with interview administration, matching, slot proposal
    const w2 = await onboardWorker(api, { areaIds: [areaId] });
    await approveCheck(api, { accessToken: A }, w2, 'IDENTITY');
    const customerProfileId = profile.body?.id as string;
    if (need('admin booking', customerProfileId)) {
      const ab = await hit('POST', '/admin/bookings', {
        t: A,
        body: {
          customerId: customerProfileId,
          category: 'HOUSE_MAID',
          areaId,
          engagement: 'PART_TIME',
          availableFrom: '09:00',
          availableTo: '12:00',
          workerId: w2.workerId,
        },
      });
      const abId = ab.body?.id as string;
      if (need('admin booking steps', abId)) {
        await hit('POST', '/workers/me/bookings/{bookingId}/{action}', {
          t: w2.accessToken,
          p: { bookingId: abId, action: 'accept' },
          body: {},
        });
        await hit('PUT', '/workers/me/bookings/{bookingId}/slot-proposal', {
          t: w2.accessToken,
          p: { bookingId: abId },
          body: { proposedAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          ok: [200, 409],
        });
        await hit('POST', '/admin/matching/candidates', {
          t: A,
          body: {
            category: 'HOUSE_MAID',
            areaId,
            engagement: 'PART_TIME',
            availableFrom: '09:00',
            availableTo: '12:00',
          },
        });
        const aiv = await hit('POST', '/admin/interviews', {
          t: A,
          body: {
            bookingId: abId,
            type: 'TRIAL',
            preferredAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          },
        });
        const aivId = aiv.body?.id as string;
        if (need('admin interview steps', aivId)) {
          await hit('POST', '/admin/interviews/{interviewId}/confirm', {
            t: A,
            p: { interviewId: aivId },
            body: {},
          });
          await hit('POST', '/admin/interviews/{interviewId}/reschedule', {
            t: A,
            p: { interviewId: aivId },
            body: { preferredAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
          });
          await hit('POST', '/workers/me/interviews/{interviewId}/propose', {
            t: w2.accessToken,
            p: { interviewId: aivId },
            body: { proposedAt: new Date(Date.now() + 5 * 86_400_000).toISOString() },
          });
          await hit('POST', '/admin/interviews/{interviewId}/reject-proposal', {
            t: A,
            p: { interviewId: aivId },
            body: {},
          });
          await hit('POST', '/workers/me/interviews/{interviewId}/propose', {
            t: w2.accessToken,
            p: { interviewId: aivId },
            body: { proposedAt: new Date(Date.now() + 6 * 86_400_000).toISOString() },
          });
          await hit('POST', '/admin/interviews/{interviewId}/accept-proposal', {
            t: A,
            p: { interviewId: aivId },
            body: {},
          });
          await hit('POST', '/admin/interviews/{interviewId}/complete', {
            t: A,
            p: { interviewId: aivId },
            body: { outcomeNote: 'ok' },
          });
        }
        await hit('POST', '/admin/bookings/{bookingId}/{action}', {
          t: A,
          p: { bookingId: abId, action: 'cancel' },
          body: { reason: 'perf cancel' },
        });
      }
    }
    // a booking the worker declines, and an interview the worker declines and the customer cancels
    const w3 = await onboardWorker(api, { areaIds: [areaId] });
    await approveCheck(api, { accessToken: A }, w3, 'IDENTITY');
    const b3 = await hit('POST', '/bookings', {
      t: C2,
      body: {
        category: 'HOUSE_MAID',
        areaId,
        engagement: 'PART_TIME',
        availableFrom: '09:00',
        availableTo: '12:00',
        workerId: w3.workerId,
      },
    });
    if (need('decline steps', b3.body?.id)) {
      const iv3 = await hit('POST', '/interviews', {
        t: C2,
        body: {
          bookingId: b3.body.id,
          type: 'INTERVIEW',
          preferredAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
      });
      if (need('interview decline/cancel', iv3.body?.id)) {
        await hit('POST', '/workers/me/interviews/{interviewId}/decline', {
          t: w3.accessToken,
          p: { interviewId: iv3.body.id },
          body: { reason: 'Not available' },
        });
        await hit('POST', '/interviews/{interviewId}/cancel', {
          t: C2,
          p: { interviewId: iv3.body.id },
          body: { reason: 'Changed plans' },
          ok: [200, 409],
        });
      }
      const iv4 = await hit('POST', '/interviews', {
        t: C2,
        body: {
          bookingId: b3.body.id,
          type: 'INTERVIEW',
          preferredAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
        ok: [200, 201, 409],
      });
      if (need('worker interview cancel', iv4.body?.id)) {
        await hit('POST', '/workers/me/interviews/{interviewId}/accept', {
          t: w3.accessToken,
          p: { interviewId: iv4.body.id },
          body: {},
          ok: [200, 409],
        });
        await hit('POST', '/workers/me/interviews/{interviewId}/cancel', {
          t: w3.accessToken,
          p: { interviewId: iv4.body.id },
          body: { reason: 'Perf cancel' },
          ok: [200, 409],
        });
      }
      const iv5 = await hit('POST', '/interviews', {
        t: C2,
        body: {
          bookingId: b3.body.id,
          type: 'TRIAL',
          preferredAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        },
        ok: [200, 201, 409],
      });
      if (need('admin interview cancel', iv5.body?.id))
        await hit('POST', '/admin/interviews/{interviewId}/cancel', {
          t: A,
          p: { interviewId: iv5.body.id },
          body: { reason: 'Perf staff cancel' },
          ok: [200, 409],
        });
      await hit('POST', '/bookings/{bookingId}/slot-proposal/{answer}', {
        t: C2,
        p: { bookingId: b3.body.id, answer: 'reject' },
        ok: [200, 409],
      });
      await hit('POST', '/admin/bookings/{bookingId}/slot-proposal/{answer}', {
        t: A,
        p: { bookingId: b3.body.id, answer: 'reject' },
        ok: [200, 409],
      });
      await hit('POST', '/workers/me/bookings/{bookingId}/{action}', {
        t: w3.accessToken,
        p: { bookingId: b3.body.id, action: 'decline' },
        body: { reason: 'Not available' },
      });
      await hit('POST', '/bookings/{bookingId}/{action}', {
        t: C2,
        p: { bookingId: b3.body.id, action: 'cancel' },
        body: { reason: 'perf cancel' },
        ok: [200, 409],
      });
    }

    // ------------------------------------------------------------------ replacement: reject, cancel, approve + select (needs an ACTIVE booking with another eligible worker)
    const repBooking = await makeBooking(
      api,
      { accessToken: A },
      { accessToken: C2, userId: cust.userId },
      areaId,
      'ACTIVE',
    );
    const rep1 = await hit('POST', '/replacement-requests', {
      t: C2,
      body: { bookingId: repBooking.id, reasonCode: 'OTHER', reason: 'Perf: worker is often late' },
    });
    if (need('replacement steps', rep1.body?.id)) {
      await hit('GET', '/replacement-requests', { t: C2 });
      await hit('GET', '/replacement-requests/{requestId}', {
        t: C2,
        p: { requestId: rep1.body.id },
      });
      await hit('GET', '/admin/replacement-requests', { t: A, q: 'limit=20' });
      await hit('GET', '/admin/replacement-requests/{requestId}', {
        t: A,
        p: { requestId: rep1.body.id },
      });
      await hit('GET', '/admin/replacement-requests/{requestId}/candidates', {
        t: A,
        p: { requestId: rep1.body.id },
      });
      await hit('POST', '/admin/replacement-requests/{requestId}/reject', {
        t: A,
        p: { requestId: rep1.body.id },
        body: { remarks: 'Perf: not enough reason' },
      });
      const rep2 = await hit('POST', '/replacement-requests', {
        t: C2,
        body: { bookingId: repBooking.id, reasonCode: 'OTHER', reason: 'Perf: second request' },
      });
      if (need('replacement cancel', rep2.body?.id))
        await hit('POST', '/replacement-requests/{requestId}/cancel', {
          t: C2,
          p: { requestId: rep2.body.id },
          body: {},
        });
      const rep3 = await hit('POST', '/replacement-requests', {
        t: C2,
        body: { bookingId: repBooking.id, reasonCode: 'OTHER', reason: 'Perf: third request' },
      });
      if (need('replacement approve/select', rep3.body?.id)) {
        await hit('POST', '/admin/replacement-requests/{requestId}/approve', {
          t: A,
          p: { requestId: rep3.body.id },
          body: { remarks: 'Approved for perf' },
        });
        const alts = await hit('GET', '/replacement-requests/{requestId}/alternatives', {
          t: C2,
          p: { requestId: rep3.body.id },
        });
        const first = (alts.body?.data as Array<{ workerId: string }> | undefined)?.find(
          (a) => a.workerId !== worker1Id,
        );
        if (need('select alternative', first?.workerId))
          await hit('POST', '/replacement-requests/{requestId}/select', {
            t: C2,
            p: { requestId: rep3.body.id },
            body: { workerId: first!.workerId },
          });
        else
          await hit('POST', '/admin/replacement-requests/{requestId}/select', {
            t: A,
            p: { requestId: rep3.body.id },
            body: { workerId: w2.workerId },
          });
      }
    }

    const repBooking2 = await makeBooking(
      api,
      { accessToken: A },
      { accessToken: C2, userId: cust.userId },
      areaId,
      'ACTIVE',
    );
    const repB = await hit('POST', '/replacement-requests', {
      t: C2,
      body: {
        bookingId: repBooking2.id,
        reasonCode: 'OTHER',
        reason: 'Perf: staff handled request',
      },
    });
    if (need('staff select', repB.body?.id)) {
      await hit('POST', '/admin/replacement-requests/{requestId}/approve', {
        t: A,
        p: { requestId: repB.body.id },
        body: { remarks: 'Approved for perf' },
      });
      await hit('POST', '/admin/replacement-requests/{requestId}/select', {
        t: A,
        p: { requestId: repB.body.id },
        body: { workerId: w2.workerId },
        ok: [200, 201, 409, 422],
      });
    }
    // ------------------------------------------------------------------ support: customer, worker and staff sides
    if (need('support', sc.body?.id)) {
      const t1 = await hit('POST', '/support/tickets', {
        t: C2,
        body: {
          categoryId: sc.body.id,
          subject: 'Perf ticket',
          description: 'A ticket raised during the performance run.',
          bookingId,
        },
      });
      await hit('GET', '/support/categories', { t: C2 });
      await hit('GET', '/support/tickets', { t: C2 });
      if (need('ticket steps', t1.body?.id)) {
        const ticketId = t1.body.id as string;
        await hit('GET', '/support/tickets/{ticketId}', { t: C2, p: { ticketId } });
        await hit('POST', '/support/tickets/{ticketId}/messages', {
          t: C2,
          p: { ticketId },
          body: { body: 'Any update on this?' },
        });
        await hit('GET', '/support/tickets/{ticketId}/messages', { t: C2, p: { ticketId } });
        await hit('GET', '/admin/support/tickets', { t: A, q: 'limit=20' });
        await hit('GET', '/admin/support/tickets/{ticketId}', { t: A, p: { ticketId } });
        await hit('POST', '/admin/support/tickets/{ticketId}/assign', {
          t: A,
          p: { ticketId },
          body: {},
        });
        await hit('POST', '/admin/support/tickets/{ticketId}/priority', {
          t: A,
          p: { ticketId },
          body: { priority: 'HIGH' },
        });
        await hit('POST', '/admin/support/tickets/{ticketId}/escalate', {
          t: A,
          p: { ticketId },
          body: { reason: 'perf escalation' },
        });
        await hit('POST', '/admin/support/tickets/{ticketId}/messages', {
          t: A,
          p: { ticketId },
          body: { body: 'We are looking into it.' },
        });
        await hit('GET', '/admin/support/tickets/{ticketId}/messages', { t: A, p: { ticketId } });
        await hit('POST', '/admin/support/tickets/{ticketId}/close', {
          t: A,
          p: { ticketId },
          body: { resolution: 'Resolved during the performance run' },
        });
      }
      await hit('POST', '/support/tickets', {
        t: W1,
        body: {
          categoryId: sc.body.id,
          description: 'A worker ticket raised during the performance run.',
        },
      });
    }

    // ------------------------------------------------------------------ safety: block, report, staff views
    const blk = await hit('POST', '/safety/blocks', {
      t: C2,
      body: { workerId: w3.workerId, reason: 'Perf block' },
    });
    await hit('GET', '/safety/blocks', { t: C2 });
    if (need('unblock', blk.body?.id))
      await hit('DELETE', '/safety/blocks/{blockId}', { t: C2, p: { blockId: blk.body.id } });
    await hit('POST', '/safety/reports', {
      t: C2,
      body: { bookingId, reasonCode: 'MISCONDUCT', note: 'Perf report' },
      ok: [200, 201, 204, 400, 422],
    });
    await hit('GET', '/admin/safety/reports', { t: A });
    await hit('GET', '/admin/safety/blocks', { t: A });
    const ablk = await hit('POST', '/admin/safety/blocks', {
      t: A,
      body: { blockerUserId: cust.userId, blockedUserId: w3.userId, reason: 'Perf staff block' },
      ok: [200, 201, 400, 422],
    });
    if (need('admin unblock', ablk.body?.id))
      await hit('DELETE', '/admin/safety/blocks/{blockId}', { t: A, p: { blockId: ablk.body.id } });

    // ------------------------------------------------------------------ notifications (customer) and staff operations views
    await api.app.get(NotificationsService).dispatchOutbox();
    const notes = await hit('GET', '/notifications', { t: C2 });
    await hit('GET', '/notifications/unread-count', { t: C2 });
    const nid = (notes.body?.data as Array<{ id: string }> | undefined)?.[0]?.id;
    if (need('notification steps', nid)) {
      await hit('POST', '/notifications/{notificationId}/read', {
        t: C2,
        p: { notificationId: nid },
      });
      await hit('POST', '/notifications/{notificationId}/unread', {
        t: C2,
        p: { notificationId: nid },
      });
    }
    await hit('POST', '/notifications/read-all', { t: C2 });
    const events = await hit('GET', '/admin/notification-events', { t: A, q: 'limit=20' });
    const eid = (events.body?.data as Array<{ id: string }> | undefined)?.[0]?.id;
    if (need('outbox retry', eid))
      await hit('POST', '/admin/outbox-events/{eventId}/retry', {
        t: A,
        p: { eventId: eid },
        ok: [200, 202, 204, 404, 409, 422],
      });
    const adminNotes = await hit('GET', '/admin/notifications', { t: A, q: 'limit=20' });
    const anid = (adminNotes.body?.data as Array<{ id: string }> | undefined)?.[0]?.id;
    if (need('notification retry', anid))
      await hit('POST', '/admin/notifications/{notificationId}/retry', {
        t: A,
        p: { notificationId: anid },
        ok: [200, 202, 204, 404, 409, 422],
      });
    await hit('GET', '/admin/notifications/health', { t: A });

    // ------------------------------------------------------------------ customers (staff) and account deletion
    await hit('GET', '/admin/customers', { t: A, q: 'limit=20' });
    if (need('admin customer steps', customerProfileId)) {
      await hit('GET', '/admin/customers/{customerId}', {
        t: A,
        p: { customerId: customerProfileId },
      });
      await hit('PATCH', '/admin/customers/{customerId}/verification-status', {
        t: A,
        p: { customerId: customerProfileId },
        body: { status: 'VERIFIED' },
      });
      await hit('POST', '/admin/customers/{customerId}/notes', {
        t: A,
        p: { customerId: customerProfileId },
        body: { note: 'Perf note' },
      });
      await hit('GET', '/admin/customers/{customerId}/notes', {
        t: A,
        p: { customerId: customerProfileId },
      });
    }
    const leaver = await otpLogin('CUSTOMER');
    await hit('POST', '/me/deletion-request', { t: leaver.token, body: { reason: 'leaving' } });
    await hit('GET', '/me/deletion-request', { t: leaver.token });
    await hit('DELETE', '/me/deletion-request', { t: leaver.token });
    await hit('GET', '/admin/deletion-requests', { t: A });

    // ------------------------------------------------------------------ staff dashboards, reports, alerts, audit
    await hit('GET', '/admin/dashboard', { t: A });
    await hit('GET', '/admin/system/readiness', { t: A });
    await hit('GET', '/admin/audit-logs', { t: A, q: 'limit=20' });
    const alerts = await hit('GET', '/admin/alerts', { t: A, q: 'limit=20' });
    await hit('GET', '/admin/alerts/summary', { t: A });
    const alertId = (alerts.body?.data as Array<{ id: string }> | undefined)?.[0]?.id;
    if (need('alert steps', alertId)) {
      await hit('POST', '/admin/alerts/{alertId}/acknowledge', { t: A, p: { alertId }, body: {} });
      await hit('POST', '/admin/alerts/{alertId}/resolve', {
        t: A,
        p: { alertId },
        body: { note: 'perf' },
      });
    }
    await hit('GET', '/admin/reports', { t: A });
    for (const r of [
      'new-customers',
      'worker-registrations',
      'booking-funnel',
      'demand-by-category',
      'demand-by-area',
      'worker-utilization',
      'interview-conversion',
      'cancellation-rate',
      'replacement-rate',
      'payment-collections',
      'support-tickets',
      'top-rated-workers',
      'repeat-customers',
    ]) {
      await hit('GET', `/admin/reports/${r}`, { t: A, q: `from=${inDays(-30)}&to=${inDays(1)}` });
    }
    await hit('GET', '/admin/reports/export/{report}', {
      t: A,
      p: { report: 'booking-funnel' },
      q: `from=${inDays(-30)}&to=${inDays(1)}`,
    });

    if (need('recheck', check?.checkId))
      await hit('POST', '/admin/verification/checks/{checkId}/recheck', {
        t: A,
        p: { checkId: check!.checkId },
        body: { remarks: 'perf recheck' },
        ok: [200, 201, 204, 409, 422],
      });

    // ------------------------------------------------------------------ sign out
    const mine = (sessions.body as Array<{ id: string }> | undefined)?.[0]?.id;
    const extra = await otpLogin('CUSTOMER');
    const extraSessions = await hit('GET', '/auth/sessions', { t: extra.token });
    const other =
      (extraSessions.body as Array<{ id: string; current?: boolean }> | undefined)?.find(
        (s) => !s.current,
      )?.id ?? mine;
    if (other)
      await hit('DELETE', '/auth/sessions/{sessionId}', {
        t: extra.token,
        p: { sessionId: other },
        ok: [200, 204, 404],
      });
    await hit('POST', '/auth/logout', { t: C2 });
    await hit('POST', '/admin/account/password', {
      t: A,
      body: { currentPassword: adminUser.password, newPassword: 'another-long-password-2!' },
      ok: [200, 204, 400, 401, 422],
    });
    void customerAsCaller;
  };

  it('walks every module through its lifecycle, repeated, and records response times', async () => {
    const out = process.env.PERF_OUT ?? join(__dirname, 'out');
    mkdirSync(out, { recursive: true });
    // the fixed reference data a fresh database needs (the journeys never create the fee or the requirement for the first workers)
    const iterationErrors: string[] = [];
    for (let i = 1; i <= ITERATIONS; i += 1) {
      try {
        await iteration(i);
      } catch (error) {
        iterationErrors.push(`iteration ${i}: ${(error as Error).message.slice(0, 200)}`);
      }
    }
    const spec = (await (await fetch(`${base}/docs/openapi.json`)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const all: string[] = [];
    for (const [p, o] of Object.entries(spec.paths))
      for (const m of Object.keys(o))
        if (['get', 'post', 'put', 'patch', 'delete'].includes(m))
          all.push(`${m.toUpperCase()} ${p.replace('/api/v1', '')}`);
    writeFileSync(
      join(out, 'journeys.json'),
      JSON.stringify(
        {
          iterations: ITERATIONS,
          generatedAt: new Date().toISOString(),
          samples: [...samples.values()],
          operationsInApi: all,
          skipped: [...skipped],
          iterationErrors,
        },
        null,
        1,
      ),
    );
    expect(samples.size).toBeGreaterThan(100);
  }, 3_600_000);
});
