import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxRetention } from './outbox-retention';

/** Cross-cutting transactional outbox: business modules write events, Notifications consumes them. */
@Global()
@Module({
  providers: [OutboxRetention, OutboxService],
  exports: [OutboxService],
})
export class OutboxModule {}
