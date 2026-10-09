import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';

/** What a module that depends on Booking may react to, inside the cancelling transaction. */
export interface BookingHook {
  onCancelled(
    bookingId: string,
    actor: { kind: string; userId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void>;
}

/**
 * Same one-way-dependency pattern as WorkerSubmissionRegistry: Replacement registers itself here, so Booking never imports
 * it, yet cancelling a booking that has an open replacement request closes that request in the same transaction.
 */
@Injectable()
export class BookingLifecycleHooks {
  private readonly hooks: BookingHook[] = [];

  register(hook: BookingHook): void {
    this.hooks.push(hook);
  }

  async cancelled(
    bookingId: string,
    actor: { kind: string; userId: string | null },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    for (const hook of this.hooks) {
      await hook.onCancelled(bookingId, actor, tx);
    }
  }
}
