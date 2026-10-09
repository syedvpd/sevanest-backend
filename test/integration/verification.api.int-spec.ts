import '../support/env-api-integration';
import request from 'supertest';
import {
  ApiApp,
  bearer,
  createApiApp,
  loginAdmin,
  loginAdminWithPermissions,
  loginWithOtp,
} from '../support/api-app';
import {
  approveCheck,
  as,
  checkIdOf,
  createArea,
  onboardWorker,
  OnboardedWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';
import { ProviderError } from '../../src/integrations/provider-error';

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000';
const V = '/api/v1/workers/me/verification';
const A = '/api/v1/admin/verification';

/** Worker verification / KYC against the REAL PostgreSQL + Redis (dedicated test database), through the HTTP API. */
describe('Verification API (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let areaId: string;

  const submittedWorker = (extra: object = {}) =>
    onboardWorker(api, { areaIds: [areaId], previousEmployer: true, ...extra });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    areaId = (await createArea(api, admin)).id;
    await setRequiredChecks(api, admin, ['IDENTITY', 'ADDRESS']);
  });

  afterAll(async () => {
    await as(api, admin).put(`${A}/requirements`, { checkTypes: [] });
    await api.close();
  });

  const statusOf = async (worker: OnboardedWorker, checkType: string) => {
    const res = await as(api, worker).get(V).expect(200);
    return (res.body as { checks: Array<{ checkType: string; status: string }> }).checks.find(
      (c) => c.checkType === checkType,
    )!.status;
  };

  describe('worker: status and access', () => {
    it('shows a new worker NOT_STARTED with every check NOT_SUBMITTED and the required set', async () => {
      const worker = await submittedWorker();
      const res = await as(api, worker).get(V).expect(200);
      expect(res.body.level).toBe('NOT_STARTED');
      expect(res.body.requiredChecks).toEqual(['IDENTITY', 'ADDRESS']);
      expect(res.body.checks.map((c: { checkType: string }) => c.checkType)).toEqual([
        'IDENTITY',
        'ADDRESS',
        'EMERGENCY_CONTACT',
        'PREVIOUS_EMPLOYMENT',
        'POLICE_VERIFICATION',
      ]);
      expect(res.body.checks.every((c: { status: string }) => c.status === 'NOT_SUBMITTED')).toBe(
        true,
      );
    });

    it('answers 404 before a worker profile exists, and 401/403 for anonymous, customer and admin callers', async () => {
      const bare = await loginWithOtp(api, { appType: 'WORKER' });
      expect((await as(api, bare).get(V)).status).toBe(404);
      expect((await api.http().get(V)).status).toBe(401);
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      expect((await as(api, customer).get(V)).status).toBe(403);
      expect(
        (
          await as(api, customer).post(`${V}/checks/IDENTITY/documents`, {
            contentType: 'application/pdf',
            sizeBytes: 10,
          })
        ).status,
      ).toBe(403);
      expect((await as(api, admin).get(V)).status).toBe(403);
    });

    it('needs a submitted profile before verification can start (422 PROFILE_NOT_SUBMITTED)', async () => {
      const draft = await onboardWorker(api, { areaIds: [areaId], submit: false });
      const res = await as(api, draft).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PROFILE_NOT_SUBMITTED');
    });

    it('stops a suspended worker at once', async () => {
      const worker = await submittedWorker();
      await as(api, admin)
        .patch(`/api/v1/admin/users/${worker.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      expect((await as(api, worker).get(V)).status).toBe(401);
    });
  });

  describe('worker: documents', () => {
    it('issues a signed upload link without revealing any storage path', async () => {
      const worker = await submittedWorker();
      const res = await as(api, worker).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'image/png',
        sizeBytes: 5000,
      });
      expect(res.status).toBe(201);
      expect(res.body.upload.method).toBe('PUT');
      expect(res.body.upload.maxBytes).toBe(5000);
      expect(new Date(res.body.upload.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      // The key exists only inside the URL handed to the uploader; no other API field carries it.
      const status = await as(api, worker).get(V).expect(200);
      expect(JSON.stringify(status.body)).not.toContain(key);
      expect(JSON.stringify(status.body)).not.toContain('kyc/');
      const doc = status.body.checks[0].documents[0];
      expect(Object.keys(doc as object).sort()).toEqual(
        ['contentType', 'createdAt', 'id', 'sizeBytes', 'status', 'submitted'].sort(),
      );
      expect(doc.status).toBe('PENDING_UPLOAD');
    });

    it('rejects a content type that is not accepted, an oversized file and bad input', async () => {
      const worker = await submittedWorker();
      const post = (checkType: string, body: object) =>
        as(api, worker).post(`${V}/checks/${checkType}/documents`, body);
      const type = await post('IDENTITY', { contentType: 'text/html', sizeBytes: 10 });
      expect(type.status).toBe(422);
      expect(type.body.code).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
      const big = await post('IDENTITY', {
        contentType: 'application/pdf',
        sizeBytes: api.config.verificationDocuments.maxBytes + 1,
      });
      expect(big.status).toBe(413);
      expect(
        (await post('IDENTITY', { contentType: 'application/pdf', sizeBytes: 0 })).status,
      ).toBe(400);
      expect((await post('IDENTITY', { contentType: 'application/pdf' })).status).toBe(400);
      expect(
        (await post('PASSPORT', { contentType: 'application/pdf', sizeBytes: 5 })).status,
      ).toBe(400);
    });

    it('confirms only a document that really arrived, repeats safely, and refuses a larger object than declared', async () => {
      const worker = await submittedWorker();
      const res = await as(api, worker).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 1000,
      });
      const id = res.body.documentId as string;
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      const confirm = () => as(api, worker).post(`${V}/documents/${id}/confirm`);
      const early = await confirm();
      expect(early.status).toBe(422);
      expect(early.body.code).toBe('DOCUMENT_NOT_UPLOADED');
      api.storage.simulateUpload(key, 5000);
      expect((await confirm()).status).toBe(422);
      api.storage.simulateUpload(key, 900);
      const ok = await confirm();
      expect(ok.status).toBe(200);
      expect(ok.body.checks[0].documents[0].status).toBe('UPLOADED');
      expect((await confirm()).status).toBe(200);
      const audits = await api.prisma.auditLog.count({
        where: { action: 'verification.document_confirm', entityId: id },
      });
      expect(audits).toBe(1);
    });

    it("hides another worker's document: confirm answers 404 exactly like an unknown id", async () => {
      const owner = await submittedWorker();
      const other = await submittedWorker();
      const res = await as(api, owner).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      api.storage.simulateUpload(api.storage.issuedUploads.at(-1)!.objectKey, 100);
      const stolen = await as(api, other).post(`${V}/documents/${res.body.documentId}/confirm`);
      const unknown = await as(api, other).post(`${V}/documents/${UNKNOWN_ID}/confirm`);
      expect(stolen.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(stolen.body.code).toBe(unknown.body.code);
      expect((await as(api, other).post(`${V}/documents/not-a-uuid/confirm`)).status).toBe(400);
      // The owner's document is untouched.
      expect(
        (
          await api.prisma.verificationDocument.findUniqueOrThrow({
            where: { id: res.body.documentId },
          })
        ).status,
      ).toBe('PENDING_UPLOAD');
    });

    it('limits the open draft documents of one check', async () => {
      const worker = await submittedWorker();
      for (let i = 0; i < 10; i++) {
        const res = await as(api, worker).post(`${V}/checks/ADDRESS/documents`, {
          contentType: 'application/pdf',
          sizeBytes: 10,
        });
        expect(res.status).toBe(201);
      }
      const extra = await as(api, worker).post(`${V}/checks/ADDRESS/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      expect(extra.status).toBe(422);
      expect(extra.body.code).toBe('TOO_MANY_DOCUMENTS');
    });

    it('answers 503 and writes nothing when storage is not available', async () => {
      const worker = await submittedWorker();
      const spy = jest
        .spyOn(api.storage, 'createUploadUrl')
        .mockRejectedValueOnce(new ProviderError('storage', 'down', false));
      const res = await as(api, worker).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('STORAGE_NOT_CONFIGURED');
      expect(
        await api.prisma.workerVerificationCheck.count({ where: { workerId: worker.workerId } }),
      ).toBe(0);
    });
  });

  describe('worker: submitting a check', () => {
    it('needs a document for identity, address and police checks (422 CHECK_INCOMPLETE)', async () => {
      const worker = await submittedWorker();
      for (const type of ['IDENTITY', 'ADDRESS', 'POLICE_VERIFICATION']) {
        const res = await as(api, worker).post(`${V}/checks/${type}/submit`);
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('CHECK_INCOMPLETE');
        expect(res.body.details[0].messages).toEqual(['document']);
      }
      // A document that was requested but never uploaded does not count.
      await as(api, worker).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      expect((await as(api, worker).post(`${V}/checks/IDENTITY/submit`)).status).toBe(422);
    });

    it('checks emergency contact and previous employment against the profile data', async () => {
      const without = await onboardWorker(api, { areaIds: [areaId] });
      const missing = await as(api, without).post(`${V}/checks/PREVIOUS_EMPLOYMENT/submit`);
      expect(missing.status).toBe(422);
      expect(missing.body.details[0].messages).toEqual(['previousEmployer']);
      expect((await as(api, without).post(`${V}/checks/EMERGENCY_CONTACT/submit`)).status).toBe(
        200,
      );
      const withEmployer = await submittedWorker();
      expect(
        (await as(api, withEmployer).post(`${V}/checks/PREVIOUS_EMPLOYMENT/submit`)).status,
      ).toBe(200);
    });

    it('submits with an uploaded document, repeats without a second event, and freezes the check', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      const first = await as(api, worker).post(`${V}/checks/IDENTITY/submit`);
      expect(first.status).toBe(200);
      expect(first.body.level).toBe('IN_PROGRESS');
      expect(first.body.checks[0].status).toBe('SUBMITTED');
      expect(first.body.checks[0].documents[0].submitted).toBe(true);
      expect((await as(api, worker).post(`${V}/checks/IDENTITY/submit`)).status).toBe(200);
      const check = await api.prisma.workerVerificationCheck.findFirstOrThrow({
        where: { workerId: worker.workerId, checkType: 'IDENTITY' },
        include: { events: true },
      });
      expect(check.events).toHaveLength(1);
      // While it waits for review nothing can be added.
      const add = await as(api, worker).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      expect(add.status).toBe(409);
      expect(add.body.code).toBe('CHECK_NOT_EDITABLE');
    });

    it('ignores status and reviewer fields a worker tries to send (mass assignment)', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      const res = await as(api, worker).post(`${V}/checks/IDENTITY/submit`, {
        status: 'APPROVED',
        reviewerUserId: worker.userId,
      });
      expect(res.status).toBe(200);
      expect(res.body.checks[0].status).toBe('SUBMITTED');
      expect(res.body.level).not.toBe('VERIFIED');
    });

    it('submits exactly once when the same submission arrives in parallel', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => as(api, worker).post(`${V}/checks/IDENTITY/submit`)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const check = await api.prisma.workerVerificationCheck.findFirstOrThrow({
        where: { workerId: worker.workerId, checkType: 'IDENTITY' },
        include: { events: true },
      });
      expect(check.events).toHaveLength(1);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'verification.check_submit', entityId: check.id },
        }),
      ).toBe(1);
    });
  });

  describe('admin: access control', () => {
    it('keeps customers, workers and anonymous callers out of every admin verification endpoint', async () => {
      const worker = await submittedWorker();
      const customer = await loginWithOtp(api, { appType: 'CUSTOMER' });
      const calls: Array<[string, string, object?]> = [
        ['get', `${A}/queue`],
        ['get', `${A}/requirements`],
        ['put', `${A}/requirements`, { checkTypes: [] }],
        ['post', `${A}/checks/${UNKNOWN_ID}/start-review`],
        ['post', `${A}/checks/${UNKNOWN_ID}/approve`, {}],
        ['post', `${A}/checks/${UNKNOWN_ID}/reject`, { remarks: 'x' }],
        ['post', `${A}/checks/${UNKNOWN_ID}/recheck`, { remarks: 'x' }],
        ['get', `${A}/documents/${UNKNOWN_ID}/link`],
        ['get', `/api/v1/admin/workers/${worker.workerId}/verification`],
      ];
      const send = (
        caller: { accessToken: string } | null,
        verb: string,
        url: string,
        body?: object,
      ) => {
        const base = api.http() as unknown as Record<string, (u: string) => request.Test>;
        let req = base[verb](url);
        if (caller) req = req.set('Authorization', bearer(caller));
        return body ? req.send(body) : req;
      };
      for (const caller of [worker, customer]) {
        for (const [verb, url, body] of calls) {
          expect((await send(caller, verb, url, body)).status).toBe(403);
        }
      }
      for (const [verb, url] of calls) {
        expect((await send(null, verb, url)).status).toBe(401);
      }
    });

    it('enforces each permission separately (review, decide, document view, configure)', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const checkId = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      const documentId = (
        await api.prisma.verificationDocument.findFirstOrThrow({ where: { checkId } })
      ).id;

      const reviewOnly = await loginAdminWithPermissions(api, ['verification.review']);
      const decideOnly = await loginAdminWithPermissions(api, ['verification.decide']);
      const viewOnly = await loginAdminWithPermissions(api, ['verification.document.view']);
      const configOnly = await loginAdminWithPermissions(api, ['verification.configure']);
      const nothing = await loginAdminWithPermissions(api, ['worker.view']);

      expect((await as(api, nothing).get(`${A}/queue`)).status).toBe(403);
      expect((await as(api, reviewOnly).get(`${A}/queue`)).status).toBe(200);
      expect(
        (await as(api, reviewOnly).get(`/api/v1/admin/workers/${worker.workerId}/verification`))
          .status,
      ).toBe(200);
      expect((await as(api, decideOnly).get(`${A}/queue`)).status).toBe(403);

      // Review permission cannot decide; decide permission cannot start a review; neither can open documents.
      expect((await as(api, reviewOnly).post(`${A}/checks/${checkId}/approve`, {})).status).toBe(
        403,
      );
      expect((await as(api, decideOnly).post(`${A}/checks/${checkId}/start-review`)).status).toBe(
        403,
      );
      expect((await as(api, reviewOnly).get(`${A}/documents/${documentId}/link`)).status).toBe(403);
      expect((await as(api, decideOnly).get(`${A}/documents/${documentId}/link`)).status).toBe(403);
      expect((await as(api, viewOnly).get(`${A}/documents/${documentId}/link`)).status).toBe(200);
      expect((await as(api, viewOnly).get(`${A}/queue`)).status).toBe(403);

      expect((await as(api, reviewOnly).put(`${A}/requirements`, { checkTypes: [] })).status).toBe(
        403,
      );
      expect((await as(api, configOnly).get(`${A}/requirements`)).status).toBe(403);
      const same = await as(api, admin).get(`${A}/requirements`).expect(200);
      expect((await as(api, configOnly).put(`${A}/requirements`, same.body as object)).status).toBe(
        200,
      );

      expect((await as(api, reviewOnly).post(`${A}/checks/${checkId}/start-review`)).status).toBe(
        200,
      );
      expect(
        (await as(api, decideOnly).post(`${A}/checks/${checkId}/reject`, { remarks: 'blurred' }))
          .status,
      ).toBe(200);
    });
  });

  describe('admin: queue and review state machine', () => {
    it('lists the queue oldest first, filters it, and bounds the page size', async () => {
      const w1 = await submittedWorker();
      const w2 = await submittedWorker();
      await uploadDocument(api, w1, 'IDENTITY');
      await as(api, w1).post(`${V}/checks/IDENTITY/submit`).expect(200);
      await as(api, w2).post(`${V}/checks/EMERGENCY_CONTACT/submit`).expect(200);
      const queue = await as(api, admin).get(`${A}/queue?limit=100`).expect(200);
      const mine = queue.body.data.filter((i: { workerId: string }) =>
        [w1.workerId, w2.workerId].includes(i.workerId),
      );
      expect(mine.map((i: { workerId: string }) => i.workerId)).toEqual([w1.workerId, w2.workerId]);
      expect(mine[0].uploadedDocuments).toBe(1);
      expect(mine[1].uploadedDocuments).toBe(0);
      expect(Object.keys(mine[0] as object).sort()).toEqual(
        ['checkId', 'checkType', 'status', 'submittedAt', 'uploadedDocuments', 'workerId'].sort(),
      );
      const identity = await as(api, admin)
        .get(`${A}/queue?checkType=EMERGENCY_CONTACT&limit=100`)
        .expect(200);
      expect(
        identity.body.data.every((i: { checkType: string }) => i.checkType === 'EMERGENCY_CONTACT'),
      ).toBe(true);
      expect((await as(api, admin).get(`${A}/queue?limit=101`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}/queue?page=0`)).status).toBe(400);
      expect((await as(api, admin).get(`${A}/queue?status=APPROVEDISH`)).status).toBe(400);
    });

    it('only allows SUBMITTED to IN_REVIEW to APPROVED/REJECTED; every other move is 409 INVALID_TRANSITION', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const id = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      const a = as(api, admin);
      // Not yet in review.
      for (const [path, body] of [
        ['approve', {}],
        ['reject', { remarks: 'no' }],
        ['recheck', { remarks: 'no' }],
      ] as const) {
        const res = await a.post(`${A}/checks/${id}/${path}`, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('INVALID_TRANSITION');
      }
      expect((await a.post(`${A}/checks/${id}/start-review`)).status).toBe(200);
      expect((await a.post(`${A}/checks/${id}/start-review`)).status).toBe(200);
      expect((await a.post(`${A}/checks/${id}/recheck`, { remarks: 'no' })).status).toBe(409);
      const approved = await a.post(`${A}/checks/${id}/approve`, { remarks: 'ID matches' });
      expect(approved.status).toBe(200);
      for (const [path, body] of [
        ['start-review', {}],
        ['approve', {}],
        ['reject', { remarks: 'late' }],
      ] as const) {
        expect((await a.post(`${A}/checks/${id}/${path}`, body)).status).toBe(409);
      }
      const view = (
        await a.get(`/api/v1/admin/workers/${worker.workerId}/verification`).expect(200)
      ).body;
      const check = view.checks.find((c: { checkType: string }) => c.checkType === 'IDENTITY');
      expect(check.status).toBe('APPROVED');
      expect(check.reviewerUserId).toBe(admin.userId);
      expect(check.history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        'SUBMITTED',
        'IN_REVIEW',
        'APPROVED',
      ]);
    });

    it('validates remarks and the re-check date, and answers 404/400 for bad ids', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const id = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      const a = as(api, admin);
      await a.post(`${A}/checks/${id}/start-review`).expect(200);
      expect((await a.post(`${A}/checks/${id}/reject`, {})).status).toBe(400);
      expect((await a.post(`${A}/checks/${id}/reject`, { remarks: '   ' })).status).toBe(400);
      expect((await a.post(`${A}/checks/${id}/reject`, { remarks: 'x'.repeat(1001) })).status).toBe(
        400,
      );
      for (const recheckAt of ['2020-01-01', '2999-02-30', 'tomorrow', '2999-13-01']) {
        expect((await a.post(`${A}/checks/${id}/approve`, { recheckAt })).status).toBe(400);
      }
      expect((await a.post(`${A}/checks/${UNKNOWN_ID}/approve`, {})).status).toBe(404);
      expect((await a.post(`${A}/checks/not-a-uuid/approve`, {})).status).toBe(400);
      expect((await a.get(`/api/v1/admin/workers/${UNKNOWN_ID}/verification`)).status).toBe(404);
      // Still waiting: nothing above changed it.
      expect(await statusOf(worker, 'IDENTITY')).toBe('IN_REVIEW');
    });

    it('rejects with remarks, shows them to the worker, accepts a resubmission, and keeps every attempt in the history', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const id = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      await as(api, admin).post(`${A}/checks/${id}/start-review`).expect(200);
      await as(api, admin)
        .post(`${A}/checks/${id}/reject`, { remarks: 'Photo is blurred' })
        .expect(200);

      const seen = await as(api, worker).get(V).expect(200);
      expect(seen.body.checks[0].status).toBe('REJECTED');
      expect(seen.body.checks[0].remarks).toBe('Photo is blurred');
      expect(seen.body.level).toBe('IN_PROGRESS');

      await uploadDocument(api, worker, 'IDENTITY');
      const again = await as(api, worker).post(`${V}/checks/IDENTITY/submit`);
      expect(again.status).toBe(200);
      expect(again.body.checks[0].status).toBe('SUBMITTED');
      expect(again.body.checks[0].remarks).toBeNull();
      expect(again.body.checks[0].documents).toHaveLength(2);

      const view = (
        await as(api, admin)
          .get(`/api/v1/admin/workers/${worker.workerId}/verification`)
          .expect(200)
      ).body;
      const history = view.checks[0].history;
      expect(history.map((h: { toStatus: string }) => h.toStatus)).toEqual([
        'SUBMITTED',
        'IN_REVIEW',
        'REJECTED',
        'SUBMITTED',
      ]);
      expect(history[2].remarks).toBe('Photo is blurred');
      expect(history[2].actorUserId).toBe(admin.userId);
    });

    it('lets only one of many parallel decisions win', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const id = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      await as(api, admin).post(`${A}/checks/${id}/start-review`).expect(200);
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () => as(api, admin).post(`${A}/checks/${id}/approve`, {})),
        ...Array.from({ length: 4 }, () =>
          as(api, admin).post(`${A}/checks/${id}/reject`, { remarks: 'no' }),
        ),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
      const events = await api.prisma.workerVerificationEvent.findMany({ where: { checkId: id } });
      expect(
        events.filter((e) => e.toStatus === 'APPROVED' || e.toStatus === 'REJECTED'),
      ).toHaveLength(1);
      expect(
        await api.prisma.auditLog.count({
          where: { entityId: id, action: { in: ['verification.approve', 'verification.reject'] } },
        }),
      ).toBe(1);
    });
  });

  describe('worker-level verification (the badge rule)', () => {
    it('is VERIFIED only when every required check is approved, and never while a check is only submitted or in review', async () => {
      const worker = await submittedWorker();
      expect((await as(api, worker).get(V)).body.level).toBe('NOT_STARTED');
      await approveCheck(api, admin, worker, 'IDENTITY');
      let view = (await as(api, worker).get(V).expect(200)).body;
      expect(view.level).toBe('IN_PROGRESS');

      // ADDRESS is submitted but only in review: still not verified.
      await uploadDocument(api, worker, 'ADDRESS');
      await as(api, worker).post(`${V}/checks/ADDRESS/submit`).expect(200);
      const addressId = await checkIdOf(api, admin, worker.workerId, 'ADDRESS');
      await as(api, admin).post(`${A}/checks/${addressId}/start-review`).expect(200);
      expect((await as(api, worker).get(V).expect(200)).body.level).toBe('IN_PROGRESS');

      await as(api, admin).post(`${A}/checks/${addressId}/approve`, {}).expect(200);
      view = (await as(api, worker).get(V).expect(200)).body;
      expect(view.level).toBe('VERIFIED');
      // A non-required check does not matter.
      expect(
        view.checks.find((c: { checkType: string }) => c.checkType === 'POLICE_VERIFICATION')
          .required,
      ).toBe(false);
    });

    it('never counts anyone as verified while no check is required (fails closed), and follows a change of the set at once', async () => {
      const worker = await submittedWorker();
      await approveCheck(api, admin, worker, 'IDENTITY');
      await approveCheck(api, admin, worker, 'ADDRESS');
      expect((await as(api, worker).get(V)).body.level).toBe('VERIFIED');
      try {
        await setRequiredChecks(api, admin, []);
        expect((await as(api, worker).get(V)).body.level).toBe('IN_PROGRESS');
        await setRequiredChecks(api, admin, ['IDENTITY']);
        expect((await as(api, worker).get(V)).body.level).toBe('VERIFIED');
        await setRequiredChecks(api, admin, ['IDENTITY', 'POLICE_VERIFICATION']);
        expect((await as(api, worker).get(V)).body.level).toBe('IN_PROGRESS');
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY', 'ADDRESS']);
      }
    });

    it('moves an approved check back to review on re-check, which ends the verified status immediately', async () => {
      const worker = await submittedWorker();
      const identityId = await approveCheck(api, admin, worker, 'IDENTITY');
      await approveCheck(api, admin, worker, 'ADDRESS');
      expect((await as(api, worker).get(V)).body.level).toBe('VERIFIED');
      expect((await as(api, admin).post(`${A}/checks/${identityId}/recheck`, {})).status).toBe(400);
      await as(api, admin)
        .post(`${A}/checks/${identityId}/recheck`, { remarks: 'Document expired' })
        .expect(200);
      const view = (await as(api, worker).get(V).expect(200)).body;
      expect(view.level).toBe('IN_PROGRESS');
      expect(view.checks[0].status).toBe('IN_REVIEW');
      expect(view.checks[0].recheckAt).toBeNull();
    });

    it('treats an approval whose re-check date has been reached as RECHECK_DUE and lets the worker resubmit', async () => {
      const worker = await submittedWorker();
      const identityId = await approveCheck(api, admin, worker, 'IDENTITY', '2999-01-01');
      await approveCheck(api, admin, worker, 'ADDRESS');
      expect((await as(api, worker).get(V)).body.level).toBe('VERIFIED');
      // Time passes: the stored date is now today or earlier.
      await api.prisma
        .$executeRaw`UPDATE worker_verification_checks SET recheck_at = ((now() AT TIME ZONE 'Asia/Kolkata')::date) WHERE id = ${identityId}::uuid`;
      const due = (await as(api, worker).get(V).expect(200)).body;
      expect(due.checks[0].status).toBe('RECHECK_DUE');
      expect(due.level).toBe('IN_PROGRESS');
      await uploadDocument(api, worker, 'IDENTITY');
      const again = await as(api, worker).post(`${V}/checks/IDENTITY/submit`);
      expect(again.status).toBe(200);
      expect(again.body.checks[0].status).toBe('SUBMITTED');
      expect(again.body.checks[0].recheckAt).toBeNull();
    });
  });

  describe('admin: documents (KYC) access', () => {
    it('issues a short-lived link only for uploaded documents, audits every issue, and never returns the storage path', async () => {
      const worker = await submittedWorker();
      const documentId = await uploadDocument(api, worker, 'IDENTITY');
      const pending = await as(api, worker).post(`${V}/checks/ADDRESS/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 10,
      });
      const res = await as(api, admin).get(`${A}/documents/${documentId}/link`);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual(['expiresAt', 'url']);
      expect(new Date(res.body.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(res.body.expiresAt as string).getTime()).toBeLessThanOrEqual(
        Date.now() + api.config.verificationDocuments.signedUrlTtlSeconds * 1000 + 2000,
      );
      expect(
        (await as(api, admin).get(`${A}/documents/${pending.body.documentId}/link`)).status,
      ).toBe(404);
      expect((await as(api, admin).get(`${A}/documents/${UNKNOWN_ID}/link`)).status).toBe(404);
      expect((await as(api, admin).get(`${A}/documents/bad/link`)).status).toBe(400);

      await as(api, admin).get(`${A}/documents/${documentId}/link`).expect(200);
      const audits = await api.prisma.auditLog.findMany({
        where: { action: 'verification.document_view', entityId: documentId },
      });
      expect(audits).toHaveLength(2);
      expect(audits[0].actorId).toBe(admin.userId);
      const serialised = JSON.stringify(audits);
      expect(serialised).not.toContain('kyc/');
      expect(serialised).not.toContain('memory://');
    });

    it('returns no link (and writes no audit row) when the storage adapter fails, and 503 when it is not configured', async () => {
      const worker = await submittedWorker();
      const documentId = await uploadDocument(api, worker, 'IDENTITY');
      const spy = jest
        .spyOn(api.storage, 'createDownloadUrl')
        .mockRejectedValueOnce(new ProviderError('storage', 'down', false));
      const res = await as(api, admin).get(`${A}/documents/${documentId}/link`);
      spy.mockRestore();
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('STORAGE_NOT_CONFIGURED');
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'verification.document_view', entityId: documentId },
        }),
      ).toBe(0);
    });

    it('keeps KYC material out of every ordinary worker response', async () => {
      const worker = await submittedWorker();
      await uploadDocument(api, worker, 'IDENTITY');
      const key = api.storage.issuedUploads.at(-1)!.objectKey;
      const responses = [
        await as(api, worker).get('/api/v1/workers/me'),
        await as(api, admin).get(`/api/v1/admin/workers/${worker.workerId}`),
        await as(api, admin).get('/api/v1/admin/workers?limit=100'),
        await as(api, worker).get(V),
        await as(api, admin).get(`/api/v1/admin/workers/${worker.workerId}/verification`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text).not.toContain(key);
        expect(text).not.toContain('objectKey');
        expect(text).not.toContain('kyc/');
        expect(text).not.toContain('memory://');
      }
    });
  });

  describe('admin: required checks (configuration)', () => {
    it('replaces the set, is idempotent, rejects bad input, and audits the before/after', async () => {
      const a = as(api, admin);
      try {
        const before = await api.prisma.auditLog.count({
          where: { action: 'verification.requirements_set' },
        });
        const set = await a.put(`${A}/requirements`, {
          checkTypes: ['POLICE_VERIFICATION', 'IDENTITY'],
        });
        expect(set.status).toBe(200);
        expect(set.body.checkTypes).toEqual(['IDENTITY', 'POLICE_VERIFICATION']);
        await a
          .put(`${A}/requirements`, { checkTypes: ['IDENTITY', 'POLICE_VERIFICATION'] })
          .expect(200);
        expect(
          await api.prisma.auditLog.count({ where: { action: 'verification.requirements_set' } }),
        ).toBe(before + 1);
        const last = await api.prisma.auditLog.findFirstOrThrow({
          where: { action: 'verification.requirements_set' },
          orderBy: { createdAt: 'desc' },
        });
        expect(last.metadata).toEqual({
          before: ['IDENTITY', 'ADDRESS'],
          after: ['IDENTITY', 'POLICE_VERIFICATION'],
        });
        expect(
          (await a.put(`${A}/requirements`, { checkTypes: ['IDENTITY', 'IDENTITY'] })).status,
        ).toBe(400);
        expect((await a.put(`${A}/requirements`, { checkTypes: ['PASSPORT'] })).status).toBe(400);
        expect((await a.put(`${A}/requirements`, {})).status).toBe(400);
        expect((await a.get(`${A}/requirements`).expect(200)).body.checkTypes).toEqual([
          'IDENTITY',
          'POLICE_VERIFICATION',
        ]);
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY', 'ADDRESS']);
      }
    });

    it('converges to one of the requested sets when two administrators replace it at once', async () => {
      try {
        const sets = [['IDENTITY'], ['ADDRESS', 'POLICE_VERIFICATION']];
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            as(api, admin).put(`${A}/requirements`, { checkTypes: sets[i % 2] }),
          ),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        const final = (await as(api, admin).get(`${A}/requirements`)).body.checkTypes as string[];
        expect([
          JSON.stringify(['IDENTITY']),
          JSON.stringify(['ADDRESS', 'POLICE_VERIFICATION']),
        ]).toContain(JSON.stringify(final));
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY', 'ADDRESS']);
      }
    });
  });

  describe('audit trail and history', () => {
    it('records every worker and staff action with actor, and keeps remarks and storage keys out of the audit log', async () => {
      const worker = await submittedWorker();
      const documentId = await uploadDocument(api, worker, 'IDENTITY');
      await as(api, worker).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const id = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      await as(api, admin).post(`${A}/checks/${id}/start-review`).expect(200);
      await as(api, admin)
        .post(`${A}/checks/${id}/reject`, { remarks: 'SECRET-REMARK-TEXT' })
        .expect(200);
      await as(api, admin).get(`${A}/documents/${documentId}/link`).expect(200);

      const rows = await api.prisma.auditLog.findMany({
        where: { OR: [{ entityId: id }, { entityId: documentId }] },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows.map((r) => r.action)).toEqual([
        'verification.document_request',
        'verification.document_confirm',
        'verification.check_submit',
        'verification.start_review',
        'verification.reject',
        'verification.document_view',
      ]);
      expect(rows[0].actorId).toBe(worker.userId);
      expect(rows[4].actorId).toBe(admin.userId);
      expect(rows[4].actorRole).toContain('SUPER_ADMIN');
      const text = JSON.stringify(rows);
      expect(text).not.toContain('SECRET-REMARK-TEXT');
      expect(text).not.toContain('kyc/');
      // The remark is in the verification history, where only reviewers can read it.
      const events = await api.prisma.workerVerificationEvent.findMany({ where: { checkId: id } });
      expect(events.some((e) => e.remarks === 'SECRET-REMARK-TEXT')).toBe(true);
    });
  });

  describe('database invariants', () => {
    it('refuses to change or delete verification history', async () => {
      const worker = await submittedWorker();
      await as(api, worker).post(`${V}/checks/EMERGENCY_CONTACT/submit`).expect(200);
      const event = await api.prisma.workerVerificationEvent.findFirstOrThrow({
        where: { check: { workerId: worker.workerId } },
      });
      await expect(
        api.prisma
          .$executeRaw`UPDATE worker_verification_events SET remarks = 'x' WHERE id = ${event.id}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        api.prisma.$executeRaw`DELETE FROM worker_verification_events WHERE id = ${event.id}::uuid`,
      ).rejects.toThrow(/append-only/);
    });

    it('refuses impossible states even from a direct SQL write', async () => {
      const worker = await submittedWorker();
      await as(api, worker).post(`${V}/checks/EMERGENCY_CONTACT/submit`).expect(200);
      const check = await api.prisma.workerVerificationCheck.findFirstOrThrow({
        where: { workerId: worker.workerId },
      });
      const run = (sql: string) => api.prisma.$executeRawUnsafe(sql);
      // Approved without a reviewer; rejected without remarks; re-check date on a non-approval.
      await expect(
        run(`UPDATE worker_verification_checks SET status = 'APPROVED' WHERE id = '${check.id}'`),
      ).rejects.toThrow();
      await expect(
        run(
          `UPDATE worker_verification_checks SET status = 'REJECTED', reviewed_at = now(), reviewer_user_id = '${admin.userId}' WHERE id = '${check.id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `UPDATE worker_verification_checks SET recheck_at = '2999-01-01' WHERE id = '${check.id}'`,
        ),
      ).rejects.toThrow();
      // A second row for the same worker and check type.
      await expect(
        run(
          `INSERT INTO worker_verification_checks (id, worker_id, check_type, updated_at) VALUES (gen_random_uuid(), '${worker.workerId}', 'EMERGENCY_CONTACT', now())`,
        ),
      ).rejects.toThrow();
      // Zero-byte document; a submitted document that was never uploaded.
      await expect(
        run(
          `INSERT INTO verification_documents (id, check_id, object_key, content_type, size_bytes) VALUES (gen_random_uuid(), '${check.id}', 'k-${check.id}', 'application/pdf', 0)`,
        ),
      ).rejects.toThrow();
      await expect(
        run(
          `INSERT INTO verification_documents (id, check_id, object_key, content_type, size_bytes, submitted_at) VALUES (gen_random_uuid(), '${check.id}', 'k2-${check.id}', 'application/pdf', 5, now())`,
        ),
      ).rejects.toThrow();
    });
  });
});
