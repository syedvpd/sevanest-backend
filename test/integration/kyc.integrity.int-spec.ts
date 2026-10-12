import '../support/env-api-integration';
import { createHash } from 'node:crypto';
import { buildSampleFile } from '../../src/integrations/storage/file-signature';
import { ProviderError } from '../../src/integrations/provider-error';
import { VerificationService } from '../../src/modules/verification/verification.service';
import { ApiApp, createApiApp, loginAdmin } from '../support/api-app';
import {
  as,
  createArea,
  onboardWorker,
  setRequiredChecks,
  uploadDocument,
} from '../support/workforce';

const V = '/api/v1/workers/me/verification';
const A = '/api/v1/admin/verification';

/**
 * KYC upload integrity against the real database: the server checks the real bytes (not the client's MIME type or file name), the
 * declared size, records a content hash, discards rejected uploads, and re-checks integrity before a reviewer gets a link.
 * Object storage is the in-memory test double; real-bucket behaviour (Supabase/S3) is NOT covered here.
 */
describe('KYC upload integrity (integration)', () => {
  let api: ApiApp;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let areaId: string;

  const worker = () => onboardWorker(api, { areaIds: [areaId], previousEmployer: true });
  const slot = async (
    w: Awaited<ReturnType<typeof worker>>,
    contentType: string,
    sizeBytes: number,
  ) => {
    const res = await as(api, w).post(`${V}/checks/IDENTITY/documents`, { contentType, sizeBytes });
    expect(res.status).toBe(201);
    return {
      id: res.body.documentId as string,
      key: api.storage.issuedUploads.at(-1)!.objectKey,
      confirm: () => as(api, w).post(`${V}/documents/${res.body.documentId}/confirm`),
    };
  };
  const row = (id: string) => api.prisma.verificationDocument.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    api = await createApiApp();
    admin = await loginAdmin(api);
    areaId = (await createArea(api, admin)).id;
    await setRequiredChecks(api, admin, ['IDENTITY']);
  });
  afterAll(async () => {
    await setRequiredChecks(api, admin, []);
    await api.close();
  });

  describe('content is validated, not trusted', () => {
    it.each([
      ['application/pdf', '<html><body><script>alert(1)</script></body></html>'],
      ['image/png', '<!DOCTYPE html><svg onload=alert(1)>'],
      ['image/jpeg', 'GIF89a............'],
      ['application/pdf', '\u0000\u0000\u0000\u0000'],
    ])('refuses and discards markup or other content declared as %s', async (type, payload) => {
      const w = await worker();
      const { id, key, confirm } = await slot(w, type, 100);
      api.storage.simulateUpload(
        key,
        100,
        Buffer.concat([Buffer.from(payload), Buffer.alloc(100 - payload.length)]),
      );
      const res = await confirm();
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DOCUMENT_CONTENT_MISMATCH');
      expect(api.storage.has(key)).toBe(false);
      expect(await row(id)).toMatchObject({
        status: 'PENDING_UPLOAD',
        contentSha256: null,
        uploadedAt: null,
      });
    });

    it('refuses a spoofed type: a genuine PNG declared as JPEG, a JPEG declared as PDF', async () => {
      const w = await worker();
      const a = await slot(w, 'image/jpeg', 300);
      api.storage.simulateUpload(a.key, 300, buildSampleFile('image/png', 300));
      expect((await a.confirm()).body.code).toBe('DOCUMENT_CONTENT_MISMATCH');
      const b = await slot(w, 'application/pdf', 300);
      api.storage.simulateUpload(b.key, 300, buildSampleFile('image/jpeg', 300));
      expect((await b.confirm()).body.code).toBe('DOCUMENT_CONTENT_MISMATCH');
    });

    it.each(['application/pdf', 'image/jpeg', 'image/png'])(
      'refuses a %s with a valid start that is cut short, and accepts the complete file',
      async (type) => {
        const w = await worker();
        const whole = buildSampleFile(type, 2000);
        const cut = await slot(w, type, 1000);
        api.storage.simulateUpload(cut.key, 1000, whole.subarray(0, 1000));
        const res = await cut.confirm();
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('DOCUMENT_CONTENT_MISMATCH');
        expect(await row(cut.id)).toMatchObject({ rejectionCode: 'CONTENT_TRUNCATED' });

        const good = await slot(w, type, 2000);
        api.storage.simulateUpload(good.key, 2000, whole);
        expect((await good.confirm()).status).toBe(200);
      },
    );

    it('refuses an empty object and an object that is not there, without touching other uploads', async () => {
      const w = await worker();
      const empty = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(empty.key, 0, Buffer.alloc(0));
      const res = await empty.confirm();
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DOCUMENT_NOT_UPLOADED');
      expect(api.storage.has(empty.key)).toBe(false);

      const missing = await slot(w, 'application/pdf', 100);
      expect((await missing.confirm()).body.code).toBe('DOCUMENT_NOT_UPLOADED');
      expect(await row(missing.id)).toMatchObject({ purgedAt: null, rejectionCode: null }); // may still be uploaded
      api.storage.simulateUpload(missing.key, 100);
      expect((await missing.confirm()).status).toBe(200);
    });

    it('refuses an oversized object even when the client declared a small size, and removes it', async () => {
      const w = await worker();
      const max = api.config.verificationDocuments.maxBytes;
      const small = await slot(w, 'application/pdf', 1000);
      api.storage.simulateUpload(small.key, max + 1, buildSampleFile('application/pdf', max + 1));
      expect((await small.confirm()).status).toBe(422);
      expect(api.storage.has(small.key)).toBe(false);
      // and a declared size above the limit never gets an upload URL in the first place
      const tooBig = await as(api, w).post(`${V}/checks/IDENTITY/documents`, {
        contentType: 'application/pdf',
        sizeBytes: max + 1,
      });
      expect(tooBig.status).toBe(413);
    });

    it('a rejected slot cannot be revived: only a fresh upload slot works', async () => {
      const w = await worker();
      const bad = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(bad.key, 100, Buffer.alloc(100, 0x41));
      expect((await bad.confirm()).status).toBe(422);
      api.storage.simulateUpload(bad.key, 100); // a perfectly valid file at the same key afterwards
      expect((await bad.confirm()).status).toBe(422);
      expect((await row(bad.id)).status).toBe('PENDING_UPLOAD');
    });
  });

  describe('storage failures never confirm or mark anything', () => {
    it('leaves the document unconfirmed when storage is unavailable during confirmation', async () => {
      const w = await worker();
      const { id, key, confirm } = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(key, 100);
      const original = api.storage.readObject.bind(api.storage);
      api.storage.readObject = () => Promise.reject(new ProviderError('storage', 'down', true));
      try {
        const res = await confirm();
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(await row(id)).toMatchObject({
          status: 'PENDING_UPLOAD',
          uploadedAt: null,
          purgedAt: null,
        });
        expect(api.storage.has(key)).toBe(true);
      } finally {
        api.storage.readObject = original;
      }
      expect((await confirm()).status).toBe(200);
    });

    it('still refuses the upload when discarding it fails, and the sweeper discards it later', async () => {
      const w = await worker();
      const { id, key, confirm } = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(key, 100, Buffer.alloc(100, 0x41));
      api.storage.failNextDelete = true;
      expect((await confirm()).status).toBe(422);
      expect(api.storage.has(key)).toBe(true); // could not be removed now
      expect((await row(id)).purgedAt).toBeNull(); // so it is not claimed as discarded

      await api.prisma.verificationDocument.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
      });
      const purged = await api.app.get(VerificationService).purgeAbandonedUploads(24 * 3_600_000);
      expect(purged).toBeGreaterThanOrEqual(1);
      expect(api.storage.has(key)).toBe(false);
      expect(await row(id)).toMatchObject({ rejectionCode: 'ABANDONED' });
    });
  });

  describe('abandoned uploads', () => {
    it('are discarded after the grace period, never confirmed documents', async () => {
      const w = await worker();
      const confirmedId = await uploadDocument(api, w, 'IDENTITY');
      const confirmed = await row(confirmedId);
      const abandoned = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(abandoned.key, 100); // uploaded, never confirmed
      const fresh = await slot(w, 'application/pdf', 100);
      api.storage.simulateUpload(fresh.key, 100);
      const old = new Date(Date.now() - 25 * 3_600_000);
      await api.prisma.verificationDocument.updateMany({
        where: { id: { in: [confirmedId, abandoned.id] } },
        data: { createdAt: old },
      });
      await api.app.get(VerificationService).purgeAbandonedUploads(24 * 3_600_000);
      expect(api.storage.has(abandoned.key)).toBe(false);
      expect(await row(abandoned.id)).toMatchObject({ rejectionCode: 'ABANDONED' });
      expect(api.storage.has(confirmed.objectKey)).toBe(true);
      expect((await row(confirmedId)).purgedAt).toBeNull();
      expect(api.storage.has(fresh.key)).toBe(true); // still inside the grace period
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'verification.document_abandoned_purged', entityId: abandoned.id },
        }),
      ).toBe(1);
    });
  });

  describe('integrity at review time', () => {
    it('records the content hash at confirmation and checks it before issuing a link', async () => {
      const w = await worker();
      const { id, key, confirm } = await slot(w, 'image/png', 4000);
      const content = buildSampleFile('image/png', 4000);
      api.storage.simulateUpload(key, 4000, content);
      expect((await confirm()).status).toBe(200);
      expect((await row(id)).contentSha256).toBe(
        createHash('sha256').update(content).digest('hex'),
      );

      const ok = await as(api, admin).get(`${A}/documents/${id}/link`);
      expect(ok.status).toBe(200);
      expect(Object.keys(ok.body as object).sort()).toEqual(['expiresAt', 'url']);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'verification.document_view', entityId: id },
      });
      expect(audit.metadata).toMatchObject({ integrityChecked: true });
    });

    it('refuses to show a document whose stored bytes changed after confirmation, and audits it', async () => {
      const w = await worker();
      const { id, key, confirm } = await slot(w, 'application/pdf', 3000);
      api.storage.simulateUpload(key, 3000);
      expect((await confirm()).status).toBe(200);

      // Swapped for a different (still valid-looking) file of the same size.
      const swapped = Buffer.concat([buildSampleFile('application/pdf', 2999), Buffer.from('\n')]);
      api.storage.replaceContent(key, swapped);
      const res = await as(api, admin).get(`${A}/documents/${id}/link`);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DOCUMENT_INTEGRITY_FAILED');
      expect(JSON.stringify(res.body)).not.toContain(key);
      expect(api.storage.issuedDownloads).not.toContain(key);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'verification.document_integrity_failed', entityId: id },
        }),
      ).toBe(1);
      expect(
        await api.prisma.auditLog.count({
          where: { action: 'verification.document_view', entityId: id },
        }),
      ).toBe(0);
      // Nothing was marked verified or approved by the failure.
      expect((await row(id)).status).toBe('UPLOADED');

      // Deleted from the bucket entirely: same refusal.
      api.storage.deleteObject(key).catch(() => undefined);
      expect((await as(api, admin).get(`${A}/documents/${id}/link`)).status).toBe(409);
    });

    it('still serves documents confirmed before hashes existed, and says in the audit that no hash was checked', async () => {
      const w = await worker();
      const id = await uploadDocument(api, w, 'IDENTITY');
      await api.prisma.verificationDocument.update({
        where: { id },
        data: { contentSha256: null },
      });
      expect((await as(api, admin).get(`${A}/documents/${id}/link`)).status).toBe(200);
      const audit = await api.prisma.auditLog.findFirstOrThrow({
        where: { action: 'verification.document_view', entityId: id },
      });
      expect(audit.metadata).toMatchObject({ integrityChecked: false });
    });
  });
});
