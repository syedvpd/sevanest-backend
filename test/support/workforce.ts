import { ApiApp, bearer, loginWithOtp, unique } from './api-app';

export type Caller = { accessToken: string };

/** Authenticated HTTP verbs for one caller. */
export function as(api: ApiApp, caller: Caller) {
  return {
    get: (url: string) => api.http().get(url).set('Authorization', bearer(caller)),
    post: (url: string, body: object = {}) =>
      api.http().post(url).set('Authorization', bearer(caller)).send(body),
    patch: (url: string, body: object = {}) =>
      api.http().patch(url).set('Authorization', bearer(caller)).send(body),
    delete: (url: string) => api.http().delete(url).set('Authorization', bearer(caller)),
    put: (url: string, body: object = {}) =>
      api.http().put(url).set('Authorization', bearer(caller)).send(body),
  };
}

export interface OnboardedWorker extends Caller {
  userId: string;
  workerId: string;
  mobile: string;
  refreshToken: string;
}

export interface OnboardOptions {
  name?: string;
  categoryCodes?: string[];
  areaIds?: string[];
  engagement?: 'FULL_TIME' | 'PART_TIME' | 'LIVE_IN' | 'DAILY' | 'HOURLY' | 'SHIFT' | 'ONE_TIME';
  windows?: Array<{ start: string; end: string }>;
  experienceMonths?: number;
  languages?: string[];
  /** Default true. false leaves the profile as a DRAFT. */
  submit?: boolean;
  previousEmployer?: boolean;
}

export async function createArea(
  api: ApiApp,
  admin: Caller,
  extra: object = {},
): Promise<{ id: string; name: string; city: string }> {
  const res = await as(api, admin).post('/api/v1/admin/service-areas', {
    name: `Area ${unique()}`,
    city: `City ${unique()}`,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`area: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; city: string };
}

export async function categoryId(api: ApiApp, code: string): Promise<string> {
  const category = await api.prisma.serviceCategory.findUniqueOrThrow({ where: { code } });
  return category.id;
}

/** Creates a worker account and, through the public API, a complete (and by default submitted) profile. */
export async function onboardWorker(
  api: ApiApp,
  options: OnboardOptions = {},
): Promise<OnboardedWorker> {
  const session = await loginWithOtp(api, { appType: 'WORKER' });
  const worker = as(api, session);
  const created = await worker.post('/api/v1/workers/me', { name: options.name ?? 'Ramesh Kumar' });
  if (created.status !== 201) throw new Error(`profile: ${created.status}`);
  const workerId = (created.body as { id: string }).id;
  const patch = await worker.patch('/api/v1/workers/me', {
    address: { line: '1 Main Rd', area: 'Madhapur', city: 'Hyderabad', pincode: '500081' },
    emergencyContact: { name: 'Lakshmi Devi', mobile: '9876543210' },
    languages: options.languages ?? ['en', 'hi'],
    experienceMonths: options.experienceMonths ?? 36,
    expectedSalary: 18000,
    ...(options.previousEmployer
      ? { previousEmployer: { name: 'Mrs Rao', mobile: '9876500000' } }
      : {}),
  });
  if (patch.status !== 200) throw new Error(`patch: ${patch.status} ${JSON.stringify(patch.body)}`);
  const ids = await Promise.all(
    (options.categoryCodes ?? ['HOUSE_MAID']).map((c) => categoryId(api, c)),
  );
  await worker.put('/api/v1/workers/me/categories', { categoryIds: ids }).expect(200);
  if (options.areaIds) {
    await worker
      .patch('/api/v1/workers/me/availability', {
        engagementPreference: options.engagement ?? 'PART_TIME',
        areaIds: options.areaIds,
        timeWindows: options.windows ?? [{ start: '08:00', end: '14:00' }],
      })
      .expect(200);
  }
  if (options.submit !== false) {
    const submitted = await worker.post('/api/v1/workers/me/submit');
    if (submitted.status !== 200) {
      throw new Error(`submit: ${submitted.status} ${JSON.stringify(submitted.body)}`);
    }
  }
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.userId,
    mobile: session.mobile!,
    workerId,
  };
}

export async function setRequiredChecks(
  api: ApiApp,
  admin: Caller,
  checkTypes: string[],
): Promise<void> {
  await as(api, admin).put('/api/v1/admin/verification/requirements', { checkTypes }).expect(200);
}

interface CheckBody {
  checkType: string;
  status: string;
  documents: Array<{ id: string }>;
}

/** Worker uploads one document (through the signed-link flow) and confirms it. Returns the document id. */
export async function uploadDocument(
  api: ApiApp,
  worker: Caller,
  checkType: string,
  options: { contentType?: string; sizeBytes?: number } = {},
): Promise<string> {
  const contentType = options.contentType ?? 'application/pdf';
  const sizeBytes = options.sizeBytes ?? 2000;
  const res = await as(api, worker).post(
    `/api/v1/workers/me/verification/checks/${checkType}/documents`,
    { contentType, sizeBytes },
  );
  if (res.status !== 201) throw new Error(`upload url: ${res.status} ${JSON.stringify(res.body)}`);
  const documentId = (res.body as { documentId: string }).documentId;
  const issued = api.storage.issuedUploads[api.storage.issuedUploads.length - 1];
  api.storage.simulateUpload(issued.objectKey, sizeBytes);
  const confirmed = await as(api, worker).post(
    `/api/v1/workers/me/verification/documents/${documentId}/confirm`,
  );
  if (confirmed.status !== 200) {
    throw new Error(`confirm: ${confirmed.status} ${JSON.stringify(confirmed.body)}`);
  }
  return documentId;
}

/** Looks up the check id of a worker's check through the admin API. */
export async function checkIdOf(
  api: ApiApp,
  admin: Caller,
  workerId: string,
  checkType: string,
): Promise<string> {
  const res = await as(api, admin)
    .get(`/api/v1/admin/workers/${workerId}/verification`)
    .expect(200);
  const check = (res.body as { checks: Array<{ checkType: string; checkId: string }> }).checks.find(
    (c) => c.checkType === checkType,
  );
  if (!check || !check.checkId) throw new Error(`no ${checkType} check for ${workerId}`);
  return check.checkId;
}

/** Worker submits the check (with a document where one is needed) and staff approve it. */
export async function approveCheck(
  api: ApiApp,
  admin: Caller,
  worker: OnboardedWorker,
  checkType: string,
  recheckAt?: string,
): Promise<string> {
  const needsDocument = [
    'IDENTITY',
    'ADDRESS',
    'POLICE_VERIFICATION',
    'SKILL_CERTIFICATE',
    'LICENSE',
  ].includes(checkType);
  if (needsDocument) await uploadDocument(api, worker, checkType);
  const submitted = await as(api, worker).post(
    `/api/v1/workers/me/verification/checks/${checkType}/submit`,
  );
  if (submitted.status !== 200) {
    throw new Error(`submit ${checkType}: ${submitted.status} ${JSON.stringify(submitted.body)}`);
  }
  const id = await checkIdOf(api, admin, worker.workerId, checkType);
  const A = `/api/v1/admin/verification/checks/${id}`;
  await as(api, admin).post(`${A}/start-review`).expect(200);
  // Approval prerequisites (D-90): an employer call note, the police reference, a validity end for licence and police clearance.
  if (checkType === 'PREVIOUS_EMPLOYMENT') {
    await as(api, admin)
      .post(`${A}/notes`, { kind: 'CALL', body: 'Employer confirmed.' })
      .expect(200);
  }
  if (checkType === 'POLICE_VERIFICATION' || checkType === 'LICENSE') {
    await as(api, admin)
      .put(`${A}/document-details`, {
        ...(checkType === 'POLICE_VERIFICATION' ? { documentNumber: 'PCC-2026-0001234' } : {}),
        expiresOn: '2099-01-01',
      })
      .expect(200);
  }
  await as(api, admin)
    .post(`${A}/approve`, recheckAt ? { recheckAt } : {})
    .expect(200);
  await signOffAndActivateIfVerified(api, admin, worker);
  return id;
}

/**
 * D-90: a fully verified worker is live in search only after the final sign-off and the activation. Test workers become matchable
 * the moment their last required check is approved, as before, by taking those two steps here (activation is best effort: a worker
 * without a service area cannot be activated and was never searchable anyway).
 */
export async function signOffAndActivateIfVerified(
  api: ApiApp,
  admin: Caller,
  worker: OnboardedWorker,
): Promise<void> {
  const dossier = await as(api, admin)
    .get(`/api/v1/admin/workers/${worker.workerId}/verification`)
    .expect(200);
  if ((dossier.body as { level: string }).level !== 'VERIFIED') return;
  await as(api, admin).post(`/api/v1/admin/workers/${worker.workerId}/verification/sign-off`, {});
  await as(api, worker).put('/api/v1/workers/me/criminal-declaration', {
    hasCriminalRecord: false,
    accepted: true,
  });
  await as(api, admin).post(`/api/v1/admin/workers/${worker.workerId}/activate`, {});
}

export type { CheckBody };
export const uniqueName = (prefix: string): string => `${prefix} ${unique()}`;
