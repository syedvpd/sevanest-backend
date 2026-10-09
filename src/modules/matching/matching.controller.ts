import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { MatchCandidatesResponse, MatchRequirementDto } from './dto/matching.dto';
import { MatchingService } from './matching.service';

/** Staff-side matching for a customer requirement (FR-WD-006/007). Read-only: it assigns nothing. */
@ApiTags('Admin - Matching')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/matching', version: '1' })
export class MatchingController {
  constructor(
    private readonly matching: MatchingService,
    private readonly users: UsersService,
  ) {}

  @Post('candidates')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.MATCHING_RUN)
  @ApiOkResponse({ type: MatchCandidatesResponse })
  @ApiOperation({
    summary: 'Candidates for a requirement (paginated, audited)',
    description:
      'A POST because the body is the requirement; nothing is stored or assigned. Candidates are active, profile-submitted, fully verified workers who offer the category in the area with the engagement and a window covering the timings. The list is stable-ordered and not ranked. 422 CATEGORY_NOT_AVAILABLE / AREA_NOT_AVAILABLE.',
  })
  async candidates(
    @Body() dto: MatchRequirementDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<MatchCandidatesResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.matching.candidatesFor(dto, { userId: admin.userId, roles: access.roles });
  }
}
