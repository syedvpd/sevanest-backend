import { Global, Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import { SecurityEventService } from './security-events.service';

/** Cross-cutting audit capability (PRD §11.1 "Audit & Security Layer"); not a business module. */
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [AuditRepository, AuditService, SecurityEventService],
  exports: [AuditService, SecurityEventService],
})
export class AuditModule {}
