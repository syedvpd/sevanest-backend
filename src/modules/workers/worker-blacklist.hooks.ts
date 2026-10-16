import { Injectable } from '@nestjs/common';

export type BlacklistListener = (event: {
  workerId: string;
  userId: string;
  reason: string;
  actorUserId: string;
}) => Promise<void>;

/**
 * Same one-way-dependency pattern as WorkerSubmissionRegistry: Booking registers a listener at startup, so a blacklisting can flag the
 * worker's open bookings to staff without Workers importing Booking.
 */
@Injectable()
export class WorkerBlacklistHooks {
  private readonly listeners: BlacklistListener[] = [];

  register(listener: BlacklistListener): void {
    this.listeners.push(listener);
  }

  async blacklisted(event: Parameters<BlacklistListener>[0]): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }
}
