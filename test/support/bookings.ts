import { ApiApp } from './api-app';
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

/** Takes a fresh booking with a fresh verified worker through the real HTTP lifecycle up to `stage`. */
export async function makeBooking(
  api: ApiApp,
  admin: Caller,
  customer: Caller & { userId: string },
  areaId: string,
  stage: Stage,
): Promise<TestBooking> {
  const worker = await onboardWorker(api, { areaIds: [areaId] });
  await approveCheck(api, admin, worker, 'IDENTITY');
  const c = as(api, customer);
  const created = await c.post('/api/v1/bookings', {
    category: 'HOUSE_MAID',
    areaId,
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
  await c.post(`/api/v1/bookings/${id}/confirm-worker`, { startDate: inDays(1) }).expect(200);
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
