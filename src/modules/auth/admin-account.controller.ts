import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { AuthService } from './auth.service';
import { ChangeAdminPasswordDto } from './dto/auth.dto';

/** Admin self-service account routes. Admin-only routes live under /admin/ (enforced by the route inventory test). */
@ApiTags('Admin account')
@Controller({ path: 'admin/account', version: '1' })
export class AdminAccountController {
  constructor(private readonly auth: AuthService) {}

  @ApiBearerAuth()
  @RequireUserType('ADMIN')
  @Post('password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change my admin password',
    description:
      'Needs the current password. Revokes every other session of this admin; the current session stays signed in. Wrong current passwords count towards the admin login lockout.',
  })
  async changeAdminPassword(
    @Body() dto: ChangeAdminPasswordDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
  ): Promise<{ revokedSessions: number }> {
    return this.auth.changeAdminPassword(user.userId, user.sessionId, dto, request.ip ?? 'unknown');
  }
}
