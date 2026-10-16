import { BookingSweepService } from './booking-sweep.service';

const ops = (over: Record<string, number>) => ({
  workerResponseHours: 4,
  workerReassignHours: 24,
  pendingPaymentAlertHours: 1,
  pendingPaymentAutoCancelHours: 12,
  ...over,
});

function build(config: Record<string, number>) {
  const repository = {
    findNoResponse: jest.fn().mockResolvedValue([]),
    findWaitingForPayment: jest.fn().mockResolvedValue([]),
  };
  const service = new BookingSweepService(
    repository as never,
    { autoCancelUnpaid: jest.fn() } as never,
    { raise: jest.fn() } as never,
    { ops: ops(config) } as never,
  );
  return { service, repository };
}

describe('BookingSweepService timers', () => {
  it('looks at every rule with the built-in defaults', async () => {
    const { service, repository } = build({});
    await service.runOnce();
    expect(repository.findNoResponse).toHaveBeenCalled();
    expect(repository.findWaitingForPayment).toHaveBeenCalledTimes(2);
  });

  it('does nothing when every timer is explicitly 0', async () => {
    const { service, repository } = build({
      workerResponseHours: 0,
      pendingPaymentAlertHours: 0,
      pendingPaymentAutoCancelHours: 0,
    });
    await service.runOnce();
    expect(repository.findNoResponse).not.toHaveBeenCalled();
    expect(repository.findWaitingForPayment).not.toHaveBeenCalled();
  });
});
