import { Module } from '@nestjs/common';
import { ReadinessService } from './readiness.service';
import { SystemController } from './system.controller';

/** Operational self-check for administrators. Read-only. */
@Module({
  controllers: [SystemController],
  providers: [ReadinessService],
  exports: [ReadinessService],
})
export class SystemModule {}
