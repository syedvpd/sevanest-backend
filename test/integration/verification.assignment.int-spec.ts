import '../support/env-api-integration';
import { ApiApp, createApiApp, loginAdmin, loginAdminWithPermissions } from '../support/api-app';
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

const A = '/api/v1/admin/verification';
const V = '/api/v1/workers/me/verification';

/** Reviewer assignment (claim), My Reviews filters, queue metadata and the signed document link contract. Real PostgreSQL. */
describe('Verification assignment and queue contract (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let areaId: string;
  let reviewerA: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let reviewerB: Awaited<ReturnType<typeof loginAdminWithPermissions>>;

  const submittedCheck = async (checkType = 'EMERGENCY_CONTACT', namePrefix = 'Asha') => {
    const worker = await onboardWorker(api, {
      areaIds: [areaId],
      previousEmployer: true,
      name: `${namePrefix} ${letters()}`,
    });
    await as(api, worker).post(`${V}/checks/${checkType}/submit`).expect(200);
    const checkId = await checkIdOf(api, admin, worker.workerId, checkType);
    return { worker, checkId };
  };

  const letters = (): string =>
    Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join(
      '',
    );

  const rowOf = (checkId: string) =>
    api.prisma.workerVerificationCheck.findUniqueOrThrow({ where: { id: checkId } });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    areaId = (await createArea(api, admin)).id;
    await setRequiredChecks(api, admin, ['EMERGENCY_CONTACT', 'PREVIOUS_EMPLOYMENT']);
    reviewerA = await loginAdminWithPermissions(api, [
      'verification.review',
      'verification.decide',
      'verification.document.view',
    ]);
    reviewerB = await loginAdminWithPermissions(api, [
      'verification.review',
      'verification.decide',
    ]);
  });

  afterAll(async () => {
    await as(api, admin).put(`${A}/requirements`, { checkTypes: [] });
    await api.close();
  });

  describe('start-review persists the reviewer', () => {
    it('stores reviewer and claim time, repeats idempotently for the owner, and refuses another reviewer', async () => {
      const { checkId } = await submittedCheck();
      expect((await rowOf(checkId)).reviewerUserId).toBeNull();

      const first = await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`);
      expect(first.status).toBe(200);
      const view = (first.body.checks as Array<{ checkId: string }>).find(
        (c) => c.checkId === checkId,
      ) as unknown as { reviewerUserId: string; claimedAt: string; status: string };
      expect(view.status).toBe('IN_REVIEW');
      expect(view.reviewerUserId).toBe(reviewerA.userId);
      const row = await rowOf(checkId);
      expect(row.reviewerUserId).toBe(reviewerA.userId);
      expect(row.claimedAt).not.toBeNull();
      expect(view.claimedAt).toBe(row.claimedAt!.toISOString());

      // Owner repeats: nothing changes (claim time and history stay).
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
      expect((await rowOf(checkId)).claimedAt!.getTime()).toBe(row.claimedAt!.getTime());
      expect(await api.prisma.workerVerificationEvent.count({ where: { checkId } })).toBe(2);

      // Another reviewer cannot take it over; no reassignment exists.
      const other = await as(api, reviewerB).post(`${A}/checks/${checkId}/start-review`);
      expect(other.status).toBe(409);
      expect(other.body.code).toBe('CHECK_ALREADY_ASSIGNED');
      expect((await rowOf(checkId)).reviewerUserId).toBe(reviewerA.userId);
    });

    it('lets exactly one of two simultaneous claims win', async () => {
      const { checkId } = await submittedCheck();
      const [a, b] = await Promise.all([
        as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`),
        as(api, reviewerB).post(`${A}/checks/${checkId}/start-review`),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const winner = a.status === 200 ? reviewerA : reviewerB;
      expect((await rowOf(checkId)).reviewerUserId).toBe(winner.userId);
      expect(await api.prisma.workerVerificationEvent.count({ where: { checkId } })).toBe(2);
    });

    it('audits the claim and keeps IN_REVIEW alone from proving assignment: a re-checked check is unassigned until claimed', async () => {
      const worker = await onboardWorker(api, { areaIds: [areaId], previousEmployer: true });
      const checkId = await approveCheck(api, admin, worker, 'EMERGENCY_CONTACT');
      await as(api, reviewerA)
        .post(`${A}/checks/${checkId}/recheck`, { remarks: 'new number' })
        .expect(200);
      const row = await rowOf(checkId);
      expect(row.status).toBe('IN_REVIEW');
      expect(row.reviewerUserId).toBeNull();
      expect(row.claimedAt).toBeNull();

      const queue = await as(api, reviewerA).get(`${A}/queue?assignedTo=me&limit=100`).expect(200);
      expect(queue.body.data.some((i: { checkId: string }) => i.checkId === checkId)).toBe(false);

      await as(api, reviewerB).post(`${A}/checks/${checkId}/start-review`).expect(200);
      expect((await rowOf(checkId)).reviewerUserId).toBe(reviewerB.userId);
      const audit = await api.prisma.auditLog.findFirst({
        where: {
          action: 'verification.start_review',
          entityId: checkId,
          actorId: reviewerB.userId,
        },
      });
      expect(audit).not.toBeNull();
    });
  });

  describe('queue: My Reviews and metadata', () => {
    it('assignedTo=me returns only my cases, reviewerId filters another reviewer, and both together are refused', async () => {
      const mine = await submittedCheck();
      const theirs = await submittedCheck();
      const free = await submittedCheck();
      await as(api, reviewerA).post(`${A}/checks/${mine.checkId}/start-review`).expect(200);
      await as(api, reviewerB).post(`${A}/checks/${theirs.checkId}/start-review`).expect(200);

      const ids = async (caller: typeof reviewerA, qs: string) =>
        (
          (await as(api, caller).get(`${A}/queue?${qs}&limit=100`).expect(200)).body.data as Array<{
            checkId: string;
          }>
        ).map((i) => i.checkId);

      const meA = await ids(reviewerA, 'assignedTo=me');
      expect(meA).toContain(mine.checkId);
      expect(meA).not.toContain(theirs.checkId);
      expect(meA).not.toContain(free.checkId);
      const meB = await ids(reviewerB, 'assignedTo=me');
      expect(meB).toContain(theirs.checkId);
      expect(meB).not.toContain(mine.checkId);
      // A caller-supplied identity is a plain filter; "me" always means the token's user.
      expect(await ids(reviewerA, `reviewerId=${reviewerB.userId}`)).toContain(theirs.checkId);
      expect(await ids(reviewerA, `reviewerId=${reviewerB.userId}`)).not.toContain(mine.checkId);

      const both = await as(api, reviewerA).get(
        `${A}/queue?assignedTo=me&reviewerId=${reviewerB.userId}`,
      );
      expect(both.status).toBe(400);
      expect((await as(api, reviewerA).get(`${A}/queue?assignedTo=someone`)).status).toBe(400);
      expect((await as(api, reviewerA).get(`${A}/queue?reviewerId=nope`)).status).toBe(400);
    });

    it('returns worker identity, submission time and assignment, orders oldest first with a stable tie-break, and filters by name', async () => {
      const tag = `Ordr${letters()}`;
      const first = await submittedCheck('EMERGENCY_CONTACT', tag);
      const second = await submittedCheck('EMERGENCY_CONTACT', tag);
      const profile = await api.prisma.workerProfile.findUniqueOrThrow({
        where: { id: first.worker.workerId },
      });
      await as(api, reviewerA).post(`${A}/checks/${first.checkId}/start-review`).expect(200);

      const res = await as(api, reviewerA)
        .get(`${A}/queue?search=${encodeURIComponent(profile.name)}&limit=100`)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      const item = res.body.data[0];
      expect(item).toMatchObject({
        checkId: first.checkId,
        workerId: first.worker.workerId,
        workerName: profile.name,
        applicationSubmittedAt: profile.submittedAt!.toISOString(),
        checkType: 'EMERGENCY_CONTACT',
        status: 'IN_REVIEW',
        submittedAt: (await rowOf(first.checkId)).submittedAt!.toISOString(),
        reviewerUserId: reviewerA.userId,
        claimedAt: (await rowOf(first.checkId)).claimedAt!.toISOString(),
        uploadedDocuments: 0,
      });

      const all = await as(api, reviewerA).get(`${A}/queue?search=${tag}&limit=100`).expect(200);
      const order = all.body.data.map((i: { checkId: string }) => i.checkId) as string[];
      expect(order.indexOf(first.checkId)).toBeLessThan(order.indexOf(second.checkId));
      const sorted = [...all.body.data].sort(
        (
          x: { submittedAt: string; checkId: string },
          y: { submittedAt: string; checkId: string },
        ) =>
          x.submittedAt === y.submittedAt
            ? x.checkId.localeCompare(y.checkId)
            : x.submittedAt.localeCompare(y.submittedAt),
      );
      expect(all.body.data).toEqual(sorted);
    });

    it('filters by service category', async () => {
      const { worker, checkId } = await submittedCheck();
      const skill = await api.prisma.workerSkill.findFirstOrThrow({
        where: { workerId: worker.workerId },
      });
      const other = await api.prisma.serviceCategory.findFirstOrThrow({
        where: { id: { not: skill.categoryId } },
      });
      const name = (
        await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: worker.workerId } })
      ).name;
      const inCat = await as(api, reviewerA)
        .get(
          `${A}/queue?categoryId=${skill.categoryId}&search=${encodeURIComponent(name)}&limit=100`,
        )
        .expect(200);
      expect(inCat.body.data.some((i: { checkId: string }) => i.checkId === checkId)).toBe(true);
      const outCat = await as(api, reviewerA)
        .get(`${A}/queue?categoryId=${other.id}&search=${encodeURIComponent('zzzz-no-such-name')}`)
        .expect(200);
      expect(outCat.body.data).toHaveLength(0);
      const notOffered = await as(api, reviewerA)
        .get(`${A}/queue?categoryId=${other.id}&search=${encodeURIComponent(name)}&limit=100`)
        .expect(200);
      expect(notOffered.body.data.some((i: { checkId: string }) => i.checkId === checkId)).toBe(
        false,
      );
    });

    it('rejects callers without the review permission', async () => {
      const nothing = await loginAdminWithPermissions(api, ['worker.view']);
      expect((await as(api, nothing).get(`${A}/queue?assignedTo=me`)).status).toBe(403);
      expect((await api.http().get(`${A}/queue?assignedTo=me`)).status).toBe(401);
    });
  });

  describe('secure document link contract', () => {
    it('returns signedUrl (same value as url), an ISO expiry and the remaining seconds', async () => {
      const worker = await onboardWorker(api, { areaIds: [areaId], previousEmployer: true });
      const documentId = await uploadDocument(api, worker, 'IDENTITY');
      const res = await as(api, reviewerA).get(`${A}/documents/${documentId}/link`).expect(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'expiresAt',
        'expiresInSeconds',
        'signedUrl',
        'url',
      ]);
      expect(res.body.signedUrl).toBe(res.body.url);
      expect(res.body.expiresAt).toBe(new Date(res.body.expiresAt as string).toISOString());
      const ttl = api.config.verificationDocuments.signedUrlTtlSeconds;
      expect(res.body.expiresInSeconds).toBeGreaterThan(0);
      expect(res.body.expiresInSeconds).toBeLessThanOrEqual(ttl);
      expect(
        Math.abs(
          new Date(res.body.expiresAt as string).getTime() -
            (Date.now() + (res.body.expiresInSeconds as number) * 1000),
        ),
      ).toBeLessThan(3000);
      // The mock storage adapter signs this URL: this proves the contract, not a real provider.
      const row = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: documentId },
      });
      expect(api.storage.issuedDownloads.at(-1)).toBe(row.objectKey);
      expect(api.storage.has(row.objectKey)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('kyc/');
    });
  });

  describe('document references in the dossier and link errors', () => {
    it('shows documentId, mimeType and availability; only a confirmed upload is AVAILABLE; failures are distinct', async () => {
      const worker = await onboardWorker(api, { areaIds: [areaId], previousEmployer: true });
      const confirmedId = await uploadDocument(api, worker, 'IDENTITY');
      const pending = await as(api, worker)
        .post(`${V}/checks/ADDRESS/documents`, { contentType: 'image/png', sizeBytes: 500 })
        .expect(201);
      const dossier = await as(api, reviewerA)
        .get(`/api/v1/admin/workers/${worker.workerId}/verification`)
        .expect(200);
      const docs = (
        dossier.body.checks as Array<{ documents: Array<Record<string, unknown>> }>
      ).flatMap((c) => c.documents);
      const ok = docs.find((d) => d.id === confirmedId)!;
      expect(ok).toMatchObject({
        documentId: confirmedId,
        documentType: 'IDENTITY',
        mimeType: 'application/pdf',
        availability: 'AVAILABLE',
        available: true,
      });
      const waiting = docs.find((d) => d.id === pending.body.documentId)!;
      expect(waiting).toMatchObject({ availability: 'NOT_UPLOADED', available: false });
      expect(JSON.stringify(dossier.body)).not.toContain('kyc/');

      const link = (id: string) => as(api, reviewerA).get(`${A}/documents/${id}/link`);
      const notUploaded = await link(pending.body.documentId as string);
      expect(notUploaded.status).toBe(409);
      expect(notUploaded.body.code).toBe('DOCUMENT_NOT_AVAILABLE');
      expect((await link('00000000-0000-7000-8000-000000000000')).status).toBe(404);
      // A check id is not a document id.
      const checkId = await checkIdOf(api, admin, worker.workerId, 'IDENTITY');
      expect((await link(checkId)).status).toBe(404);

      const row = await api.prisma.verificationDocument.findUniqueOrThrow({
        where: { id: confirmedId },
      });
      await api.storage.deleteObject(row.objectKey);
      const gone = await link(confirmedId);
      expect(gone.status).toBe(409);
      expect(gone.body.code).toBe('DOCUMENT_OBJECT_MISSING');
    });
  });

  describe('operations discovery of verified workers', () => {
    it('lists fully verified workers with verified=true and the others with verified=false, without changing account status', async () => {
      const done = await onboardWorker(api, { areaIds: [areaId], previousEmployer: true });
      await approveCheck(api, admin, done, 'EMERGENCY_CONTACT');
      await approveCheck(api, admin, done, 'PREVIOUS_EMPLOYMENT');
      const partial: OnboardedWorker = await onboardWorker(api, {
        areaIds: [areaId],
        previousEmployer: true,
      });
      await approveCheck(api, admin, partial, 'EMERGENCY_CONTACT');

      const list = async (verified: boolean) =>
        (
          await as(api, admin)
            .get(`/api/v1/admin/workers?verified=${verified}&limit=100`)
            .expect(200)
        ).body.data as Array<{ id: string; accountStatus: string }>;
      const yes = await list(true);
      const no = await list(false);
      expect(yes.find((w) => w.id === done.workerId)?.accountStatus).toBe('ACTIVE');
      expect(yes.some((w) => w.id === partial.workerId)).toBe(false);
      expect(no.some((w) => w.id === partial.workerId)).toBe(true);
      expect(no.some((w) => w.id === done.workerId)).toBe(false);
      expect((await as(api, admin).get('/api/v1/admin/workers?verified=maybe')).status).toBe(400);
    });
  });
});
