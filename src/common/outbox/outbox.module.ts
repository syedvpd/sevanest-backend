import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';

/** Cross-cutting transactional outbox: business modules write events, Notifications consumes them. */
@Global()
@Module({
  providers: [OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
