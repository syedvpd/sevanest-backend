import { Module } from '@nestjs/common';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';

/** Retention and erasure orchestration (DEC-08). Owns no tables: owners register their tasks and erasers in the global RetentionRegistry. */
@Module({
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
