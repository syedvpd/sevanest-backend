import '../support/env-api-integration';
import { Prisma } from '../../src/generated/prisma/client';
import { activeWorkerCondition } from '../../src/modules/verification/verification-eligibility';
import { VerificationService } from '../../src/modules/verification/verification.service';
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
const W = '/api/v1/admin/workers';

/** Client decisions of 2026-10-26 (D-90, Q-123..Q-129) against the real PostgreSQL, through the HTTP API. */
describe('Verification decisions: reasons, ownership, release, notes, SLA, sign-off, activation (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let areaId: string;
  let reviewerA: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let reviewerB: Awaited<ReturnType<typeof loginAdminWithPermissions>>;
  let supervisor: Awaited<ReturnType<typeof loginAdminWithPermissions>>;

  const worker = (extra: object = {}) =>
    onboardWorker(api, { areaIds: [areaId], previousEmployer: true, ...extra });

  const submitted = async (
    checkType = 'EMERGENCY_CONTACT',
    w?: OnboardedWorker,
  ): Promise<{ worker: OnboardedWorker; checkId: string }> => {
    const subject = w ?? (await worker());
    if (['IDENTITY', 'ADDRESS', 'POLICE_VERIFICATION', 'LICENSE'].includes(checkType)) {
      await uploadDocument(api, subject, checkType);
    }
    await as(api, subject).post(`${V}/checks/${checkType}/submit`).expect(200);
    return { worker: subject, checkId: await checkIdOf(api, admin, subject.workerId, checkType) };
  };

  const row = (checkId: string) =>
    api.prisma.workerVerificationCheck.findUniqueOrThrow({ where: { id: checkId } });

  const matchable = async (workerId: string): Promise<boolean> =>
    (
      await api.prisma.$queryRaw<Array<{ ok: boolean }>>(
        Prisma.sql`SELECT ${activeWorkerCondition('wp.id')} AS ok FROM worker_profiles wp WHERE wp.id = ${workerId}::uuid`,
      )
    )[0].ok;

  const dossier = async (workerId: string) =>
    (await as(api, admin).get(`${W}/${workerId}/verification`).expect(200)).body as {
      applicationReference: string | null;
      applicationStatus: string;
      level: string;
      signedOffAt: string | null;
      activatedAt: string | null;
      checks: Array<Record<string, unknown>>;
    };

  const events = async (event: string, userId: string) =>
    (await api.prisma.outboxEvent.findMany({ where: { topic: 'notification' } })).filter((e) => {
      // other suites leave outbox rows without a payload in the shared test database
      const p = e.payload as { event: string; recipients: string[] } | null;
      return p?.event === event && p.recipients.includes(userId);
    });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    areaId = (await createArea(api, admin)).id;
    await setRequiredChecks(api, admin, ['IDENTITY']);
    reviewerA = await loginAdminWithPermissions(api, [
      'verification.review',
      'verification.decide',
    ]);
    reviewerB = await loginAdminWithPermissions(api, [
      'verification.review',
      'verification.decide',
    ]);
    supervisor = await loginAdminWithPermissions(api, [
      'verification.review',
      'verification.decide',
      'verification.reassign',
      'verification.signoff',
      'worker.activate',
      'worker.view',
    ]);
  });

  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('application reference (Q-124)', () => {
    it('is stamped at submission as SEVA plus eight digits, is unique, and is the same everywhere', async () => {
      const draft = await onboardWorker(api, { areaIds: [areaId], submit: false });
      expect(
        (await as(api, draft).get('/api/v1/workers/me').expect(200)).body.applicationReference,
      ).toBeNull();

      const { worker: w, checkId } = await submitted();
      const mine = (await as(api, w).get('/api/v1/workers/me').expect(200)).body
        .applicationReference;
      expect(mine).toMatch(/^SEVA\d{8}$/);
      const other = (await worker()).workerId;
      const otherRef = (await as(api, admin).get(`${W}/${other}`).expect(200)).body
        .applicationReference;
      expect(otherRef).toMatch(/^SEVA\d{8}$/);
      expect(otherRef).not.toBe(mine);

      expect((await dossier(w.workerId)).applicationReference).toBe(mine);
      expect((await as(api, w).get(V).expect(200)).body.applicationReference).toBe(mine);
      const queue = await as(api, admin).get(`${A}/queue?search=${mine}&limit=100`).expect(200);
      expect(queue.body.data).toHaveLength(1);
      expect(queue.body.data[0].checkId).toBe(checkId);
      expect(queue.body.data[0].applicationReference).toBe(mine);
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.workerId } }))
          .applicationReference,
      ).toBe(mine);
    });
  });

  describe('rejection reasons (Q-126)', () => {
    it('needs an approved code, makes remarks mandatory for OTHER, and shows the worker the standard wording', async () => {
      const { worker: w, checkId } = await submitted('IDENTITY');
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
      const reject = (body: object) =>
        as(api, reviewerA).post(`${A}/checks/${checkId}/reject`, body);

      expect((await reject({ remarks: 'no code' })).status).toBe(400);
      expect((await reject({ reasonCode: 'MADE_UP' })).status).toBe(400);
      expect((await reject({ reasonCode: 'OTHER' })).status).toBe(400);
      expect((await reject({ reasonCode: 'OTHER', remarks: '  ' })).status).toBe(400);

      const ok = await reject({ reasonCode: 'BLURRY_IMAGE' });
      expect(ok.status).toBe(200);
      const saved = await row(checkId);
      expect(saved.status).toBe('REJECTED');
      expect(saved.rejectionCode).toBe('BLURRY_IMAGE');
      expect(saved.remarks).toMatch(/blurry or unreadable/);

      const seen = (await as(api, w).get(V).expect(200)).body;
      const identity = seen.checks.find((c: { checkType: string }) => c.checkType === 'IDENTITY');
      expect(identity).toMatchObject({
        status: 'REJECTED',
        rejectionCode: 'BLURRY_IMAGE',
        terminal: false,
      });
      expect(identity.rejectionMessage).toMatch(/blurry or unreadable/);
      expect(seen.applicationStatus).toBe('ACTION_REQUIRED');

      // Corrections: the worker resubmits only this check; the application returns to UNDER_REVIEW.
      await uploadDocument(api, w, 'IDENTITY');
      await as(api, w).post(`${V}/checks/IDENTITY/submit`).expect(200);
      const after = (await as(api, w).get(V).expect(200)).body;
      expect(after.applicationStatus).toBe('UNDER_REVIEW');
      expect((await row(checkId)).rejectionCode).toBeNull();
    });

    it('treats a disqualifying code as final: no resubmission and no new upload, application REJECTED', async () => {
      const { worker: w, checkId } = await submitted('IDENTITY');
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
      await as(api, reviewerA)
        .post(`${A}/checks/${checkId}/reject`, { reasonCode: 'CRIMINAL_RECORD_DISQUALIFIED' })
        .expect(200);
      const seen = (await as(api, w).get(V).expect(200)).body;
      expect(
        seen.checks.find((c: { checkType: string }) => c.checkType === 'IDENTITY').terminal,
      ).toBe(true);
      expect(seen.applicationStatus).toBe('REJECTED');
      const again = await as(api, w).post(`${V}/checks/IDENTITY/submit`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('CHECK_DISQUALIFIED');
      const upload = await as(api, w).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: 100,
      });
      expect(upload.status).toBe(409);
      expect(upload.body.code).toBe('CHECK_DISQUALIFIED');
      // A disqualified worker can never be signed off.
      expect(
        (await as(api, supervisor).post(`${W}/${w.workerId}/verification/sign-off`, {})).status,
      ).toBe(409);
    });
  });

  describe('ownership, release and reassignment (Q-125)', () => {
    it('lets only the claiming reviewer (or a supervisor) decide', async () => {
      const { checkId } = await submitted('IDENTITY');
      const notClaimed = await as(api, reviewerA).post(`${A}/checks/${checkId}/approve`, {});
      expect(notClaimed.status).toBe(409);
      expect(notClaimed.body.code).toBe('INVALID_TRANSITION');
      expect(notClaimed.body.message).toMatch(/allowed from: IN_REVIEW.*start-review/);
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
      for (const [path, body] of [
        ['approve', {}],
        ['reject', { reasonCode: 'BLURRY_IMAGE' }],
      ] as const) {
        const res = await as(api, reviewerB).post(`${A}/checks/${checkId}/${path}`, body);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHECK_NOT_ASSIGNED_TO_YOU');
      }
      await as(api, supervisor).post(`${A}/checks/${checkId}/approve`, {}).expect(200);
      expect((await row(checkId)).reviewerUserId).toBe(supervisor.userId);
    });

    it('releases a claim back to SUBMITTED for the owner or a supervisor only, and records it', async () => {
      const { checkId } = await submitted();
      expect(
        (await as(api, reviewerA).post(`${A}/checks/${checkId}/release-review`, {})).status,
      ).toBe(409);
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);

      const wrong = await as(api, reviewerB).post(`${A}/checks/${checkId}/release-review`, {});
      expect(wrong.status).toBe(409);
      expect(wrong.body.code).toBe('CHECK_NOT_ASSIGNED_TO_YOU');
      expect((await row(checkId)).reviewerUserId).toBe(reviewerA.userId);

      const released = await as(api, reviewerA).post(`${A}/checks/${checkId}/release-review`, {
        reason: 'Called away',
      });
      expect(released.status).toBe(200);
      const after = await row(checkId);
      expect(after.status).toBe('SUBMITTED');
      expect(after.reviewerUserId).toBeNull();
      expect(after.claimedAt).toBeNull();
      const again = await as(api, reviewerA).post(`${A}/checks/${checkId}/release-review`, {});
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INVALID_TRANSITION');

      // Another executive can now take it; a supervisor can force a release.
      await as(api, reviewerB).post(`${A}/checks/${checkId}/start-review`).expect(200);
      await as(api, supervisor).post(`${A}/checks/${checkId}/release-review`, {}).expect(200);
      expect((await row(checkId)).reviewerUserId).toBeNull();
      const audit = await api.prisma.auditLog.findMany({
        where: { action: 'verification.release_review', entityId: checkId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit).toHaveLength(2);
      expect((audit[1].metadata as { forced: boolean }).forced).toBe(true);
      const events = await api.prisma.workerVerificationEvent.findMany({ where: { checkId } });
      expect(events.some((e) => e.toStatus === 'SUBMITTED' && e.remarks === 'Called away')).toBe(
        true,
      );
    });

    it('reassigns only for supervisors and only to an eligible reviewer', async () => {
      const { checkId } = await submitted();
      await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
      const body = { reviewerUserId: reviewerB.userId };
      expect(
        (await as(api, reviewerA).post(`${A}/checks/${checkId}/reassign-review`, body)).status,
      ).toBe(403);
      const customer = await onboardWorker(api, { areaIds: [areaId], submit: false });
      const bad = await as(api, supervisor).post(`${A}/checks/${checkId}/reassign-review`, {
        reviewerUserId: customer.userId,
      });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('REVIEWER_NOT_ELIGIBLE');
      const noReviewPermission = await loginAdminWithPermissions(api, ['worker.view']);
      expect(
        (
          await as(api, supervisor).post(`${A}/checks/${checkId}/reassign-review`, {
            reviewerUserId: noReviewPermission.userId,
          })
        ).status,
      ).toBe(422);
      await as(api, supervisor).post(`${A}/checks/${checkId}/reassign-review`, body).expect(200);
      expect((await row(checkId)).reviewerUserId).toBe(reviewerB.userId);
      // Not IN_REVIEW: no reassignment.
      const fresh = await submitted();
      expect(
        (await as(api, supervisor).post(`${A}/checks/${fresh.checkId}/reassign-review`, body))
          .status,
      ).toBe(409);
    });

    it('releases a claim idle for 30 minutes and keeps an active one; notes and document links keep a claim alive', async () => {
      const verification = api.app.get(VerificationService);
      const idle = await submitted();
      const active = await submitted();
      const kept = await submitted('IDENTITY');
      for (const c of [idle, active, kept]) {
        await as(api, reviewerA).post(`${A}/checks/${c.checkId}/start-review`).expect(200);
      }
      const old = new Date(Date.now() - 31 * 60 * 1000);
      await api.prisma.workerVerificationCheck.updateMany({
        where: { id: { in: [idle.checkId, active.checkId, kept.checkId] } },
        data: { claimedAt: old, lastActivityAt: old },
      });
      // A note is reviewer activity: it keeps the claim.
      await as(api, reviewerA)
        .post(`${A}/checks/${active.checkId}/notes`, { kind: 'REVIEW', body: 'Still working' })
        .expect(200);
      // So is opening the document (needs the document permission: use the Super Admin as holder).
      await as(api, admin).post(`${A}/checks/${kept.checkId}/reassign-review`, {
        reviewerUserId: supervisor.userId,
      });
      await api.prisma.workerVerificationCheck.update({
        where: { id: kept.checkId },
        data: { claimedAt: old, lastActivityAt: old },
      });
      const doc = await api.prisma.verificationDocument.findFirstOrThrow({
        where: { checkId: kept.checkId },
      });
      const viewer = await loginAdminWithPermissions(api, [
        'verification.review',
        'verification.document.view',
      ]);
      await api.prisma.workerVerificationCheck.update({
        where: { id: kept.checkId },
        data: { reviewerUserId: viewer.userId },
      });
      await as(api, viewer).get(`${A}/documents/${doc.id}/link`).expect(200);

      const released = await verification.releaseInactiveClaims();
      expect(released).toBeGreaterThanOrEqual(1);
      const idleRow = await row(idle.checkId);
      expect(idleRow.status).toBe('SUBMITTED');
      expect(idleRow.reviewerUserId).toBeNull();
      expect((await row(active.checkId)).reviewerUserId).toBe(reviewerA.userId);
      expect((await row(kept.checkId)).reviewerUserId).toBe(viewer.userId);
      const audit = await api.prisma.auditLog.findFirst({
        where: { action: 'verification.claim_auto_released', entityId: idle.checkId },
      });
      expect(audit).not.toBeNull();
      expect(audit!.actorId).toBeNull();
      expect(await verification.releaseInactiveClaims()).toBe(0);
    });
  });

  describe('notes and approval requirements (Q-126)', () => {
    it('keeps notes staff-only and needs a call note before previous employment can be approved', async () => {
      await setRequiredChecks(api, admin, ['PREVIOUS_EMPLOYMENT']);
      try {
        const { worker: w, checkId } = await submitted('PREVIOUS_EMPLOYMENT');
        const note = (body: object) =>
          as(api, reviewerA).post(`${A}/checks/${checkId}/notes`, body);
        expect((await note({ kind: 'CALL', body: 'x' })).status).toBe(409); // not claimed yet
        await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);

        expect((await note({ kind: 'OTHER', body: 'x' })).status).toBe(400);
        expect((await note({ kind: 'CALL', body: '   ' })).status).toBe(400);
        const blocked = await as(api, reviewerA).post(`${A}/checks/${checkId}/approve`, {});
        expect(blocked.status).toBe(422);
        expect(blocked.body.code).toBe('APPROVAL_REQUIREMENTS_MISSING');
        expect(blocked.body.details[0].messages).toEqual(['callNote']);
        expect(
          (
            await as(api, reviewerB).post(`${A}/checks/${checkId}/notes`, {
              kind: 'CALL',
              body: 'x',
            })
          ).status,
        ).toBe(409);

        const added = await note({
          kind: 'CALL',
          body: 'Spoke to the employer, confirmed 2 years.',
        });
        expect(added.status).toBe(200);
        const adminCheck = added.body.checks.find(
          (c: { checkType: string }) => c.checkType === 'PREVIOUS_EMPLOYMENT',
        );
        expect(adminCheck.notes).toHaveLength(1);
        expect(adminCheck.notes[0]).toMatchObject({ kind: 'CALL', authorUserId: reviewerA.userId });

        // The worker never sees a note.
        expect(JSON.stringify((await as(api, w).get(V).expect(200)).body)).not.toContain(
          'Spoke to the employer',
        );
        // The audit log carries the kind, never the text.
        const audit = await api.prisma.auditLog.findMany({
          where: { action: 'verification.note_add', entityId: checkId },
        });
        expect(JSON.stringify(audit)).not.toContain('Spoke to the employer');

        await as(api, reviewerA).post(`${A}/checks/${checkId}/approve`, {}).expect(200);
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY']);
      }
    });

    it('stores only the last four characters of a document number and needs the police reference and validity end', async () => {
      await setRequiredChecks(api, admin, ['POLICE_VERIFICATION']);
      try {
        const { worker: w, checkId } = await submitted('POLICE_VERIFICATION');
        await as(api, reviewerA).post(`${A}/checks/${checkId}/start-review`).expect(200);
        const blocked = await as(api, reviewerA).post(`${A}/checks/${checkId}/approve`, {});
        expect(blocked.status).toBe(422);
        expect(blocked.body.details[0].messages).toEqual(['referenceNumber', 'expiresOn']);

        const put = (body: object) =>
          as(api, reviewerA).put(`${A}/checks/${checkId}/document-details`, body);
        expect((await put({})).status).toBe(400);
        expect((await put({ documentNumber: '12' })).status).toBe(400);
        expect((await put({ expiresOn: '2020-01-01' })).status).toBe(400);
        expect((await put({ expiresOn: '2027-02-31' })).status).toBe(400);
        expect(
          (
            await as(api, reviewerB).put(`${A}/checks/${checkId}/document-details`, {
              expiresOn: '2099-01-01',
            })
          ).status,
        ).toBe(409);

        const ok = await put({ documentNumber: 'PCC 2026 0001234', expiresOn: '2099-06-30' });
        expect(ok.status).toBe(200);
        const check = ok.body.checks.find(
          (c: { checkType: string }) => c.checkType === 'POLICE_VERIFICATION',
        );
        expect(check.maskedDocumentNumber).toBe('XXXX-XXXX-1234');
        expect(check.documentExpiresOn).toBe('2099-06-30');
        expect(JSON.stringify(ok.body)).not.toContain('0001234'.slice(0, 3) + '2026');
        const saved = await row(checkId);
        expect(saved.maskedDocumentNumber).toBe('XXXX-XXXX-1234');
        const audit = await api.prisma.auditLog.findMany({
          where: { action: 'verification.document_details', entityId: checkId },
        });
        expect(JSON.stringify(audit)).not.toContain('PCC');

        await as(api, reviewerA).post(`${A}/checks/${checkId}/approve`, {}).expect(200);
        // The validity end became the re-check date.
        expect((await row(checkId)).recheckAt?.toISOString().slice(0, 10)).toBe('2099-06-30');
        expect(
          (await as(api, w).get(V).expect(200)).body.checks.find(
            (c: { checkType: string }) => c.checkType === 'POLICE_VERIFICATION',
          ).maskedDocumentNumber,
        ).toBe('XXXX-XXXX-1234');
      } finally {
        await setRequiredChecks(api, admin, ['IDENTITY']);
      }
    });

    it('lets the worker send the number and validity when submitting, and never keeps the full number', async () => {
      const w = await worker();
      await uploadDocument(api, w, 'LICENSE');
      const bad = await as(api, w).post(`${V}/checks/LICENSE/submit`, { documentNumber: '1' });
      expect(bad.status).toBe(400);
      const ok = await as(api, w).post(`${V}/checks/LICENSE/submit`, {
        documentNumber: 'DL-04-2011-0149646',
        expiresOn: '2099-01-01',
      });
      expect(ok.status).toBe(200);
      const licence = ok.body.checks.find((c: { checkType: string }) => c.checkType === 'LICENSE');
      expect(licence.maskedDocumentNumber).toBe('XXXX-XXXX-9646');
      expect(licence.documentExpiresOn).toBe('2099-01-01');
      expect(JSON.stringify(ok.body)).not.toContain('0149646');
    });
  });

  describe('SLA fields (Q-129)', () => {
    it('flags OVERDUE after 24 business hours and STALLED_CLAIM after 2 hours, and never flags a decided check', async () => {
      const fresh = await submitted();
      const queue = async (extra = '') =>
        (await as(api, admin).get(`${A}/queue?limit=100${extra}`).expect(200)).body.data as Array<
          Record<string, unknown>
        >;
      const find = async (id: string) => (await queue()).find((i) => i.checkId === id)!;

      const first = await find(fresh.checkId);
      expect(first.isOverdue).toBe(false);
      expect(first.slaFlags).toEqual([]);
      expect(new Date(first.dueAt as string).getTime()).toBeGreaterThan(
        new Date(first.submittedAt as string).getTime(),
      );

      const longAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await api.prisma.workerVerificationCheck.update({
        where: { id: fresh.checkId },
        data: { submittedAt: longAgo },
      });
      expect((await find(fresh.checkId)).slaFlags).toEqual(['OVERDUE']);
      expect((await find(fresh.checkId)).isOverdue).toBe(true);

      await as(api, reviewerA).post(`${A}/checks/${fresh.checkId}/start-review`).expect(200);
      const claimed = await find(fresh.checkId);
      expect(claimed.slaFlags).toEqual(['OVERDUE']);
      expect(claimed.claimDueAt).not.toBeNull();
      await api.prisma.workerVerificationCheck.update({
        where: { id: fresh.checkId },
        data: { claimedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), lastActivityAt: new Date() },
      });
      expect((await find(fresh.checkId)).slaFlags).toEqual(['OVERDUE', 'STALLED_CLAIM']);

      await as(api, reviewerA).post(`${A}/checks/${fresh.checkId}/approve`, {}).expect(200);
      const decided = (await queue('&status=APPROVED')).find((i) => i.checkId === fresh.checkId)!;
      expect(decided.slaFlags).toEqual([]);
      expect(decided.isOverdue).toBe(false);
      expect(decided.decidedAt).not.toBeNull();
    });
  });

  describe('final sign-off and activation (Q-123, Q-128)', () => {
    it('keeps verified, signed off and active apart: matching needs all three, each step is permissioned and idempotent', async () => {
      const w = await worker();
      expect((await dossier(w.workerId)).applicationStatus).toBe('SUBMITTED');
      const executive = await loginAdminWithPermissions(api, [
        'verification.review',
        'verification.decide',
        'worker.view',
      ]);
      const signOff = (caller: { accessToken: string }) =>
        as(api, caller).post(`${W}/${w.workerId}/verification/sign-off`, {});
      const activate = (caller: { accessToken: string }) =>
        as(api, caller).post(`${W}/${w.workerId}/activate`, {});

      // Nothing is verified yet.
      const early = await signOff(supervisor);
      expect(early.status).toBe(409);
      expect(early.body.code).toBe('NOT_FULLY_VERIFIED');
      expect((await activate(supervisor)).body.code).toBe('NOT_SIGNED_OFF');

      // All required checks approved: verified, but not live.
      const check = await submitted('IDENTITY', w);
      await as(api, reviewerA).post(`${A}/checks/${check.checkId}/start-review`).expect(200);
      expect((await dossier(w.workerId)).applicationStatus).toBe('UNDER_REVIEW');
      await as(api, reviewerA).post(`${A}/checks/${check.checkId}/approve`, {}).expect(200);
      let d = await dossier(w.workerId);
      expect(d.level).toBe('VERIFIED');
      expect(d.applicationStatus).toBe('UNDER_REVIEW'); // awaiting the sign-off
      expect(await matchable(w.workerId)).toBe(false);
      const stillVerified = await as(api, admin).get(`${W}?verified=true&limit=100`).expect(200);
      expect(stillVerified.body.data.some((x: { id: string }) => x.id === w.workerId)).toBe(true);

      // Permissions: a verification executive can do neither step.
      expect((await signOff(executive)).status).toBe(403);
      expect((await activate(executive)).status).toBe(403);

      // Sign-off: status VERIFIED, still not live, one notification and one alert, repeats change nothing.
      const [first, second] = await Promise.all([signOff(supervisor), signOff(supervisor)]);
      expect([first.status, second.status]).toEqual([200, 200]);
      d = await dossier(w.workerId);
      expect(d.applicationStatus).toBe('VERIFIED');
      expect(d.signedOffAt).not.toBeNull();
      expect(d.activatedAt).toBeNull();
      expect(await matchable(w.workerId)).toBe(false);
      expect(await events('WORKER_VERIFIED', w.userId)).toHaveLength(1);
      const alerts = await api.prisma.adminAlert.findMany({
        where: { dedupeKey: `worker_verified:${w.workerId}` },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].requiredPermission).toBe('worker.activate');
      const stamp = (
        await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.workerId } })
      ).verificationSignedOffAt;
      await signOff(supervisor).then((r) => expect(r.status).toBe(200));
      expect(
        (await api.prisma.workerProfile.findUniqueOrThrow({ where: { id: w.workerId } }))
          .verificationSignedOffAt,
      ).toEqual(stamp);
      expect(await events('WORKER_VERIFIED', w.userId)).toHaveLength(1);

      // Activation prerequisites: the criminal self-declaration is missing.
      const blocked = await activate(supervisor);
      expect(blocked.status).toBe(422);
      expect(blocked.body.code).toBe('ACTIVATION_REQUIREMENTS_MISSING');
      expect(blocked.body.details[0].messages).toEqual(['criminalDeclaration']);
      await as(api, w)
        .put('/api/v1/workers/me/criminal-declaration', {
          hasCriminalRecord: false,
          accepted: true,
        })
        .expect(200);

      // A blacklisted worker cannot be activated.
      await api.prisma.workerProfile.update({
        where: { id: w.workerId },
        data: { blacklistedAt: new Date(), blacklistReason: 'test' },
      });
      const bl = await activate(supervisor);
      expect(bl.status).toBe(422);
      expect(bl.body.details[0].messages).toEqual(['blacklisted']);
      await api.prisma.workerProfile.update({
        where: { id: w.workerId },
        data: { blacklistedAt: null, blacklistReason: null },
      });

      const live = await activate(supervisor);
      expect(live.status).toBe(200);
      expect(live.body.applicationStatus).toBe('ACTIVE');
      expect(live.body.activatedAt).not.toBeNull();
      expect(await matchable(w.workerId)).toBe(true);
      expect((await as(api, w).get(V).expect(200)).body.applicationStatus).toBe('ACTIVE');
      expect((await activate(supervisor)).status).toBe(200);
      expect(await events('WORKER_ACTIVATED', w.userId)).toHaveLength(1);
      const audit = await api.prisma.auditLog.findMany({
        where: {
          entityId: w.workerId,
          action: { in: ['verification.worker_signoff', 'worker.activate'] },
        },
      });
      expect(audit.map((a) => a.action).sort()).toEqual([
        'verification.worker_signoff',
        'worker.activate',
      ]);

      // A re-check takes the worker out of matching at once; re-approval brings them back without a new sign-off.
      await as(api, admin)
        .post(`${A}/checks/${check.checkId}/recheck`, { remarks: 'documents changed' })
        .expect(200);
      expect(await matchable(w.workerId)).toBe(false);
      expect((await dossier(w.workerId)).applicationStatus).toBe('UNDER_REVIEW');
    });

    it('refuses activation for a suspended account and for a draft profile, and the constraint forbids activation without sign-off', async () => {
      const w = await worker();
      await approveCheck(api, admin, w, 'IDENTITY'); // helper signs off and activates
      expect(await matchable(w.workerId)).toBe(true);
      await api.prisma.workerProfile.update({
        where: { id: w.workerId },
        data: { activatedAt: null },
      });
      await as(api, admin)
        .patch(`/api/v1/admin/users/${w.userId}/status`, { status: 'SUSPENDED' })
        .expect(200);
      const res = await as(api, supervisor).post(`${W}/${w.workerId}/activate`, {});
      expect(res.status).toBe(422);
      expect(res.body.details[0].messages).toEqual(['accountSuspended']);

      const draft = await onboardWorker(api, { areaIds: [areaId], submit: false });
      expect((await as(api, supervisor).post(`${W}/${draft.workerId}/activate`, {})).status).toBe(
        422,
      );
      await expect(
        api.prisma.workerProfile.update({
          where: { id: draft.workerId },
          data: { activatedAt: new Date() },
        }),
      ).rejects.toThrow();
    });
  });

  describe('permissions and roles (D-90)', () => {
    it('registers the new permission keys and the Verification Supervisor role with its starting set', async () => {
      const codes = (await api.prisma.permission.findMany({ select: { code: true } })).map(
        (p) => p.code,
      );
      for (const key of ['verification.signoff', 'verification.reassign', 'worker.activate']) {
        expect(codes).toContain(key);
      }
      const role = await api.prisma.role.findUnique({
        where: { code: 'VERIFICATION_SUPERVISOR' },
        include: { permissions: { include: { permission: true } } },
      });
      expect(role).not.toBeNull();
      const held = role!.permissions.map((p) => p.permission.code);
      if (held.length > 0) {
        expect(held).toEqual(
          expect.arrayContaining([
            'verification.signoff',
            'verification.reassign',
            'worker.activate',
          ]),
        );
      }
      const ops = await api.prisma.role.findUnique({
        where: { code: 'OPERATIONS_ADMIN' },
        include: { permissions: { include: { permission: true } } },
      });
      if (ops!.permissions.length > 0) {
        expect(ops!.permissions.map((p) => p.permission.code)).toEqual(
          expect.arrayContaining(['worker.activate']),
        );
      }
    });
  });
});
