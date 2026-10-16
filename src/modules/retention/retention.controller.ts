import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { PermissionCode } from '../users/rbac.constants';
import { RetentionReport, RetentionService } from './retention.service';

@ApiTags('Admin - Retention')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/retention', version: '1' })
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Get('preview')
  @Permissions(PermissionCode.AUDIT_VIEW)
  @ApiOperation({
    summary: 'Dry run: how much data is past its retention period (changes nothing)',
    description:
      'Counts per task (notifications, processed outbox events, rejected KYC files) and the account deletions that are past the cooling-off period. Works whether or not RETENTION_ENABLED is on. Super Admin only (audit.view).',
  })
  preview(): Promise<RetentionReport> {
    return this.retention.runOnce({ dryRun: true, audit: false });
  }
}
