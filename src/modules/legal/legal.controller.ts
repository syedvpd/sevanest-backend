import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions, Public } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import {
  AcceptLegalDto,
  DeletionListQuery,
  DeletionRequestView,
  LegalCurrentView,
  LegalStatusView,
  RequestDeletionDto,
} from './legal.dto';
import { LegalService } from './legal.service';

/** Terms and privacy consent. The current versions are public so the apps can show them before sign-in. */
@ApiTags('Legal')
@Controller({ path: 'legal', version: '1' })
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  @Get('current')
  @ApiModelResponse(LegalStatusView)
  @Public()
  @ApiOperation({ summary: 'The current terms and privacy versions (no sign-in needed)' })
  current(): LegalCurrentView {
    return this.legal.current();
  }

  @Get('status')
  @ApiModelResponse(LegalStatusView)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Have I accepted the current versions?' })
  status(@CurrentUser() user: AuthenticatedUser): Promise<LegalStatusView> {
    return this.legal.status(user.userId);
  }

  @Post('accept')
  @ApiModelResponse(LegalStatusView)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the current terms and/or privacy version (append-only record)',
    description: '409 LEGAL_VERSION_MISMATCH for an old version; repeating is harmless.',
  })
  accept(
    @Body() dto: AcceptLegalDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LegalStatusView> {
    return this.legal.accept(user.userId, dto);
  }
}

/** My own account-deletion request (store and privacy-law requirement). Recorded and handled by staff; payment and audit records are kept. */
@ApiTags('Account')
@ApiBearerAuth()
@Controller({ path: 'me/deletion-request', version: '1' })
export class AccountDeletionController {
  constructor(private readonly legal: LegalService) {}

  @Post()
  @ApiModelResponse(DeletionRequestView, { status: 201 })
  @ApiOperation({
    summary: 'Ask for my account and personal data to be deleted',
    description:
      '409 DELETION_BLOCKED while a booking is not finished or a payment/refund is in progress. Repeating returns the open request.',
  })
  request(
    @Body() dto: RequestDeletionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeletionRequestView> {
    return this.legal.requestDeletion(user.userId, dto.reason);
  }

  @Get()
  @ApiOperation({ summary: 'My open deletion request, or null' })
  async mine(@CurrentUser() user: AuthenticatedUser): Promise<DeletionRequestView | null> {
    return this.legal.myDeletion(user.userId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw my open deletion request' })
  async cancel(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.legal.cancelDeletion(user.userId);
  }
}

@ApiTags('Admin - Account deletion')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/deletion-requests', version: '1' })
export class AdminDeletionController {
  constructor(private readonly legal: LegalService) {}

  @Get()
  @ApiPageResponse(DeletionRequestView)
  @Permissions(PermissionCode.USER_STATUS_MANAGE)
  @ApiOperation({ summary: 'Account deletion requests (newest first)' })
  list(@Query() query: DeletionListQuery): Promise<Page<DeletionRequestView>> {
    return this.legal.adminListDeletions(query);
  }
}
