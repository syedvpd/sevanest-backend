import type { Prisma } from '../../generated/prisma/client';
import type {
  PaymentProvider,
  ProviderOrder,
} from '../../integrations/payments/payment-provider.interface';
import type { BookingService } from '../booking/booking.service';
import type { PaymentRecord, PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';

describe('PaymentService order recovery', () => {
  const payment: PaymentRecord = {
    id: 'payment-uuid',
    bookingId: 'booking-uuid',
    customerUserId: 'customer-uuid',
    feeCode: 'BOOKING_FEE',
    amountMinor: 49900,
    currency: 'INR',
    status: 'CREATED',
    providerOrderId: null,
    providerPaymentId: null,
    checkoutPayload: null,
    receiptNumber: null,
    paidAt: null,
    failureReason: null,
    failureCode: null,
    paymentMethod: null,
    paymentMethodDetail: null,
    refundReason: null,
    refundProviderId: null,
    refundedAt: null,
    refundedByUserId: null,
    reconcileAttempts: 0,
    reconcileNextAt: null,
    reconcileLastNote: null,
    orderCreationStartedAt: null,
    createdAt: new Date('2026-11-08T00:00:00.000Z'),
  };

  function setup() {
    const stored = { ...payment };
    let remoteOrder: ProviderOrder | null = null;
    let updateCount = 0;
    let failUpdateAt: number | null = null;
    const repository = {
      transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        work({} as Prisma.TransactionClient),
      lock: jest.fn(() => Promise.resolve(stored)),
      update: jest.fn((_id: string, change: Partial<PaymentRecord>) => {
        updateCount++;
        if (failUpdateAt === updateCount) {
          failUpdateAt = null;
          return Promise.reject(new Error('simulated database write failure'));
        }
        Object.assign(stored, change);
        return Promise.resolve();
      }),
      findById: jest.fn(() => Promise.resolve(stored)),
    };
    const provider = {
      findOrderByReference: jest.fn(() => Promise.resolve(remoteOrder)),
      createOrder: jest.fn(() => {
        remoteOrder = {
          providerOrderId: 'order_remote_1',
          reference: payment.id,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          checkoutPayload: {
            gateway: 'razorpay',
            orderId: 'order_remote_1',
            amount: payment.amountMinor,
            currency: payment.currency,
          },
        };
        return Promise.resolve(remoteOrder);
      }),
    };
    const bookings = { lockBooking: jest.fn(() => Promise.resolve()) };
    const service = new PaymentService(
      repository as unknown as PaymentRepository,
      bookings as unknown as BookingService,
      {} as never,
      {} as never,
      {} as never,
      provider as unknown as PaymentProvider,
    );
    const openOrder = (
      service as unknown as {
        openOrder(record: PaymentRecord): Promise<PaymentRecord>;
      }
    ).openOrder.bind(service);

    return {
      stored,
      provider,
      repository,
      openOrder,
      failNextUpdate: () => {
        // The first write durably marks the attempt; fail the later write that persists the provider order.
        failUpdateAt = updateCount + 2;
      },
    };
  }

  it('recovers the created provider order after local persistence fails', async () => {
    const test = setup();
    test.failNextUpdate();

    await expect(test.openOrder(payment)).rejects.toThrow('simulated database write failure');
    expect(test.stored.providerOrderId).toBeNull();

    await expect(test.openOrder(payment)).resolves.toMatchObject({
      providerOrderId: 'order_remote_1',
      status: 'PENDING',
    });
    expect(test.provider.createOrder).toHaveBeenCalledTimes(1);
    expect(test.provider.findOrderByReference).toHaveBeenCalledTimes(2);
  });

  it('does not issue another create when a prior attempt has no discoverable order', async () => {
    const test = setup();
    test.stored.orderCreationStartedAt = new Date();

    await expect(test.openOrder(payment)).rejects.toThrow(
      'The payment gateway is not available right now',
    );
    expect(test.provider.createOrder).not.toHaveBeenCalled();
  });

  it('recovers an order after a process restart through the scheduled reconciliation path', async () => {
    const test = setup();
    test.stored.orderCreationStartedAt = new Date();
    const service = new PaymentService(
      test.repository as unknown as PaymentRepository,
      { lockBooking: jest.fn(() => Promise.resolve()) } as unknown as BookingService,
      {} as never,
      {} as never,
      {} as never,
      test.provider as unknown as PaymentProvider,
    );
    const remoteOrder: ProviderOrder = {
      providerOrderId: 'order_remote_after_restart',
      reference: payment.id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      checkoutPayload: { gateway: 'razorpay', orderId: 'order_remote_after_restart' },
    };

    await expect(service.reconcileNow(payment.id)).resolves.toBe('ORDER_NOT_FOUND');
    test.provider.findOrderByReference.mockResolvedValueOnce(remoteOrder);
    await expect(service.reconcileNow(payment.id)).resolves.toBe('ORDER_RECOVERED');
    expect(test.stored.providerOrderId).toBe(remoteOrder.providerOrderId);
    expect(test.stored.status).toBe('PENDING');
    expect(test.provider.createOrder).not.toHaveBeenCalled();
  });
});
