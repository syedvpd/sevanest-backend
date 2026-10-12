import type { HeartbeatService } from '../../infrastructure/cache/heartbeat.service';
import { PaymentRecoveryLoop } from './payment.worker';
import type { PaymentRecoveryService } from './payment-recovery.service';

/** The loop is the only thing that makes the recovery service run on its own: prove it starts, repeats, never overlaps and survives errors. */
describe('PaymentRecoveryLoop', () => {
  const run = { claimed: 0, checked: 0, failed: 0, replayed: 0, escalated: 0, flaggedCancelled: 0 };

  const heartbeat = { beat: jest.fn().mockResolvedValue(undefined) } as unknown as HeartbeatService;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('runs shortly after start-up and then every minute, and stops on shutdown', async () => {
    const runOnce = jest.fn().mockResolvedValue(run);
    const loop = new PaymentRecoveryLoop(
      { runOnce } as unknown as PaymentRecoveryService,
      heartbeat,
    );
    loop.onApplicationBootstrap();
    expect(runOnce).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(runOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    loop.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(180_000);
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow run and keeps going after a failed run', async () => {
    let release: () => void = () => undefined;
    const runOnce = jest
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve(run))))
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue(run);
    const loop = new PaymentRecoveryLoop(
      { runOnce } as unknown as PaymentRecoveryService,
      heartbeat,
    );
    loop.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(10_000); // run 1 starts and stays pending
    await jest.advanceTimersByTimeAsync(120_000); // two interval ticks while it is still running
    expect(runOnce).toHaveBeenCalledTimes(1);
    release();
    await jest.advanceTimersByTimeAsync(60_000); // run 2 throws, the loop survives
    expect(runOnce).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(runOnce).toHaveBeenCalledTimes(3);
    loop.onModuleDestroy();
  });
});
