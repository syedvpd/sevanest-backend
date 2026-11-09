import { indiaToday } from '../../src/common/time/india';
import { ApiApp, unique } from './api-app';
import { as, approveCheck, onboardWorker, OnboardedWorker } from './workforce';
import type { Caller } from './workforce';
import { FakePaymentProvider } from '../../src/integrations/payments/fake-payment.provider';
import { PAYMENT_PROVIDER } from '../../src/integrations/payments/payment-provider.interface';

export const fakeGateway = (api: ApiApp): FakePaymentProvider =>
  api.app.get<FakePaymentProvider>(PAYMENT_PROVIDER);

export const inDays = (days: number): string =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

export async function ensureFee(api: ApiApp, admin: Caller, amountMinor = 50000): Promise<void> {
  await as(api, admin)
    .put('/api/v1/admin/fees/booking-fee', { amountMinor, isActive: true })
    .expect(200);
}

export interface TestBooking {
  id: string;
  worker: OnboardedWorker;
  customer: Caller & { userId: string };
}

export type Stage =
  'MATCHED' | 'INTERVIEW_TRIAL_COMPLETED' | 'PENDING_PAYMENT' | 'CONFIRMED' | 'ACTIVE';

/**
 * D-99: home-service bookings require a customer-owned address in the service area's city.
 * Creates the customer profile once, then reuses one address per (city, area) so suites that book
 * many times for the same customer stay well under the 20-active-address cap.
 */
export async function ensureCustomerAddress(
  api: ApiApp,
  customer: Caller & { userId: string },
  areaId: string,
): Promise<string> {
  const area = await api.prisma.serviceArea.findUniqueOrThrow({ where: { id: areaId } });
  const c = as(api, customer);
  const profile = await c.get('/api/v1/customers/me');
  if (profile.status === 404) {
    const createdProfile = await c.post('/api/v1/customers/me', {
      name: 'Test Customer',
      email: `customer.${unique()}@example.test`,
      preferredLanguage: 'en',
    });
    if (createdProfile.status !== 201) {
      throw new Error(
        `customer profile: ${createdProfile.status} ${JSON.stringify(createdProfile.body)}`,
      );
    }
  } else if (profile.status !== 200) {
    throw new Error(`customer profile: ${profile.status} ${JSON.stringify(profile.body)}`);
  }
  const listed = await c.get('/api/v1/customers/me/addresses');
  if (listed.status !== 200) {
    throw new Error(`customer addresses: ${listed.status} ${JSON.stringify(listed.body)}`);
  }
  const sameArea = (listed.body as Array<{ id: string; area: string; city: string }>).find(
    (a) =>
      a.city.trim().toLowerCase() === area.city.trim().toLowerCase() &&
      a.area.trim().toLowerCase() === area.name.trim().toLowerCase(),
  );
  if (sameArea) return sameArea.id;
  const createdAddress = await c.post('/api/v1/customers/me/addresses', {
    line: `1 ${area.name} Test Lane`,
    area: area.name,
    city: area.city,
    pincode: '500001',
    label: 'Home',
  });
  if (createdAddress.status !== 201) {
    throw new Error(`address: ${createdAddress.status} ${JSON.stringify(createdAddress.body)}`);
  }
  return (createdAddress.body as { id: string }).id;
}

/** Add a customer-owned address to a valid-area booking fixture when one was not specified. */
export async function withCustomerBookingAddress(
  api: ApiApp,
  caller: { accessToken: string; userId?: string; type?: string },
  body: object,
): Promise<Record<string, unknown>> {
  const payload = body as Record<string, unknown>;
  if (caller.type !== 'CUSTOMER' || !caller.userId || 'addressId' in payload) return payload;
  const areaId = payload.areaId;
  if (typeof areaId !== 'string') return payload;
  const area = await api.prisma.serviceArea.findUnique({
    where: { id: areaId },
    select: { id: true },
  });
  if (!area) return payload;
  const addressId = await ensureCustomerAddress(
    api,
    caller as { accessToken: string; userId: string },
    area.id,
  );
  return { ...payload, addressId };
}

/** Takes a fresh booking with a fresh verified worker through the real HTTP lifecycle up to `stage`. */
export async function makeBooking(
  api: ApiApp,
  admin: Caller,
  customer: Caller & { userId: string },
  areaId: string,
  stage: Stage,
  existingWorker?: OnboardedWorker,
): Promise<TestBooking> {
  const worker = existingWorker ?? (await onboardWorker(api, { areaIds: [areaId] }));
  if (!existingWorker) await approveCheck(api, admin, worker, 'IDENTITY');
  const c = as(api, customer);
  // HOUSE_MAID is a home service, so the booking needs a customer-owned address (D-99).
  const addressId = await ensureCustomerAddress(api, customer, areaId);
  const created = await c.post('/api/v1/bookings', {
    category: 'HOUSE_MAID',
    areaId,
    addressId,
    engagement: 'PART_TIME',
    availableFrom: '09:00',
    availableTo: '12:00',
    workerId: worker.workerId,
  });
  if (created.status !== 201)
    throw new Error(`booking: ${created.status} ${JSON.stringify(created.body)}`);
  const id = (created.body as { id: string }).id;
  const result = { id, worker, customer };
  if (stage === 'MATCHED') return result;
  await c
    .post(`/api/v1/bookings/${id}/schedule`, {
      scheduleType: 'INTERVIEW',
      scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    })
    .expect(200);
  await c.post(`/api/v1/bookings/${id}/interview-complete`, { outcomeNote: 'ok' }).expect(200);
  if (stage === 'INTERVIEW_TRIAL_COMPLETED') return result;
  // A service can only be started on or after its agreed start date, so a booking that is taken all the way to ACTIVE starts today.
  await c
    .post(`/api/v1/bookings/${id}/confirm-worker`, {
      startDate: stage === 'ACTIVE' ? indiaToday() : inDays(1),
    })
    .expect(200);
  if (stage === 'PENDING_PAYMENT') return result;
  await payForBooking(api, admin, customer, id);
  if (stage === 'CONFIRMED') return result;
  await c.post(`/api/v1/bookings/${id}/start`).expect(200);
  return result;
}

/** Pays a PENDING_PAYMENT booking through the real endpoints and the fake gateway. Returns the payment id. */
export async function payForBooking(
  api: ApiApp,
  admin: Caller,
  customer: Caller,
  bookingId: string,
): Promise<string> {
  await ensureFee(api, admin);
  const created = await as(api, customer).post('/api/v1/payments', { bookingId }).expect(201);
  const orderId = (created.body as { checkout: { orderId: string } }).checkout.orderId;
  const reported = fakeGateway(api).completeCheckout(orderId, 'SUCCEEDED');
  await as(api, customer)
    .post(`/api/v1/payments/${(created.body as { id: string }).id}/verify`, {
      providerPaymentId: reported.providerPaymentId,
      signature: reported.signature,
    })
    .expect(200);
  return (created.body as { id: string }).id;
}
