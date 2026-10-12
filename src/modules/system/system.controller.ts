import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permissions } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { PermissionCode } from '../users/rbac.constants';
import { ReadinessReport, ReadinessService } from './readiness.service';

@ApiTags('Admin - System')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/system', version: '1' })
export class SystemController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('readiness')
  @Permissions(PermissionCode.ROLE_MANAGE)
  @ApiOperation({
    summary:
      'Every prerequisite for real use and whether it is met (areas, fee, verification set, providers, templates, workers)',
    description:
      'BLOCKER checks must pass before launch. `workers` lists the background loops seen in the last 3 minutes; an empty list means the worker process is not running. Read-only; no secrets.',
  })
  get(): Promise<ReadinessReport> {
    return this.readiness.report();
  }
}
