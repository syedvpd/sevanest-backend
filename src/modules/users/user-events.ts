import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import type { UserStatusChangedEvent } from './users.types';

/**
 * Tiny in-process event hub so other modules (Auth) can react to account changes without Users importing them.
 * Events are emitted AFTER the originating transaction commits. Handlers must not throw; failures are only logged
 * because the authoritative effect (the status itself) is already enforced on every request by the auth guard.
 */
@Injectable()
export class UserEvents {
  private readonly logger = new Logger(UserEvents.name);
  private readonly emitter = new EventEmitter();

  onStatusChanged(handler: (event: UserStatusChangedEvent) => Promise<void>): void {
    this.emitter.on('status-changed', (event: UserStatusChangedEvent) => {
      handler(event).catch((error: unknown) =>
        this.logger.error(
          `User status handler failed for ${event.userId}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });
  }

  emitStatusChanged(event: UserStatusChangedEvent): void {
    this.emitter.emit('status-changed', event);
  }
}
