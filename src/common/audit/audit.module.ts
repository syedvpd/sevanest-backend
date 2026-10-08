import { Global, Module } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/** Cross-cutting audit capability (PRD §11.1 "Audit & Security Layer"); not a business module. */
@Global()
@Module({
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
