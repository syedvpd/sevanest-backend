import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { UsersService } from '../users/users.service';
import { DashboardService } from './dashboard.service';
import type { DashboardView } from './dashboard.service';

/**
 * Admin dashboard (FRD FM-14). Open to every admin account; WHAT it shows is decided per section by the permissions the
 * caller already holds, so it cannot reveal data the caller could not open elsewhere.
 */
@ApiTags('Admin - Dashboard')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/dashboard', version: '1' })
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Operations dashboard: only the sections the caller is permitted to see',
  })
  async get(@CurrentUser() admin: AuthenticatedUser): Promise<DashboardView> {
    const access = await this.users.getAccess(admin.userId);
    return this.dashboard.build(access.permissions);
  }
}
