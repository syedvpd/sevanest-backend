import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminWorkerVerificationResponse,
  ApproveCheckDto,
  CHECK_TYPES,
  DocumentLinkResponse,
  DocumentUploadResponse,
  QueueItem,
  RemarksDto,
  RequestDocumentUploadDto,
  RequirementsResponse,
  SetRequirementsDto,
  VerificationQueueQuery,
  WorkerVerificationResponse,
} from './dto/verification.dto';
import type { CheckType } from './dto/verification.dto';
import { VerificationActor, VerificationService } from './verification.service';

/** The signed-in worker's own verification. Scoped to the authenticated user, never to an id from the client. */
@ApiTags('Verification')
@ApiBearerAuth()
@ApiExtraModels(
  WorkerVerificationResponse,
  AdminWorkerVerificationResponse,
  DocumentUploadResponse,
  DocumentLinkResponse,
  RequirementsResponse,
  QueueItem,
)
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/verification', version: '1' })
export class WorkerVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  @ApiOperation({
    summary: 'My verification status (FR-VER-012)',
    description:
      'Overall level and each check with its status. Rejection remarks are shown so I can resubmit. Documents appear as metadata only: no storage path, no link.',
  })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerVerificationResponse> {
    return this.verification.getMine(user.userId);
  }

  @Post('checks/:checkType/documents')
  @ApiOperation({
    summary: 'Ask for a short-lived upload link for a document of one check',
    description:
      'Upload the file to the returned URL with HTTP PUT, then confirm it. Needs a submitted profile. 422 DOCUMENT_TYPE_NOT_ALLOWED, 413 when too large, 409 CHECK_NOT_EDITABLE while the check is in review or approved, 503 when storage is not configured.',
  })
  requestUpload(
    @Param('checkType', new ParseEnumPipe(CHECK_TYPES)) checkType: CheckType,
    @Body() dto: RequestDocumentUploadDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentUploadResponse> {
    return this.verification.requestDocumentUpload(user.userId, checkType, dto);
  }

  @Post('documents/:documentId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm that a document was uploaded',
    description:
      "The server checks that the object exists and fits the declared size. Repeating the call changes nothing. Another worker's document answers 404.",
  })
  confirm(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerVerificationResponse> {
    return this.verification.confirmDocument(user.userId, documentId);
  }

  @Post('checks/:checkType/submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit one check for review',
    description:
      'Identity, address and police checks need an uploaded document; emergency-contact and previous-employment checks need that data in my profile (422 CHECK_INCOMPLETE otherwise). Repeating while it waits for review changes nothing; 409 CHECK_ALREADY_APPROVED once approved.',
  })
  submit(
    @Param('checkType', new ParseEnumPipe(CHECK_TYPES)) checkType: CheckType,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerVerificationResponse> {
    return this.verification.submitCheck(user.userId, checkType);
  }
}

/** Review of worker verification by authorised staff (FRD FM-05). Documents are never returned inline. */
@ApiTags('Admin - Verification')
@ApiBearerAuth()
@ApiExtraModels(
  WorkerVerificationResponse,
  AdminWorkerVerificationResponse,
  DocumentUploadResponse,
  DocumentLinkResponse,
  RequirementsResponse,
  QueueItem,
)
@RequireUserType('ADMIN')
@Controller({ path: 'admin/verification', version: '1' })
export class AdminVerificationController {
  constructor(
    private readonly verification: VerificationService,
    private readonly users: UsersService,
  ) {}

  @Get('queue')
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: 'Verification queue, oldest submission first (paginated)' })
  queue(@Query() query: VerificationQueueQuery): Promise<Page<QueueItem>> {
    return this.verification.queue(query);
  }

  @Get('requirements')
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: 'Checks required for a worker to count as verified' })
  requirements(): Promise<RequirementsResponse> {
    return this.verification.getRequirements();
  }

  @Put('requirements')
  @Permissions(PermissionCode.VERIFICATION_CONFIGURE)
  @ApiOperation({
    summary: 'Replace the set of required checks (audited)',
    description:
      'Which checks are mandatory is an open business decision (Q-04); nothing is required until an administrator chooses. While the set is empty no worker counts as verified.',
  })
  async setRequirements(
    @Body() dto: SetRequirementsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<RequirementsResponse> {
    return this.verification.setRequirements(dto, await this.actor(admin));
  }

  @Post('checks/:checkId/start-review')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: 'Take a submitted check into review (SUBMITTED to IN_REVIEW)' })
  async startReview(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.startReview(checkId, await this.actor(admin));
  }

  @Post('checks/:checkId/approve')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_DECIDE)
  @ApiOperation({
    summary: 'Approve a check in review',
    description:
      '409 INVALID_TRANSITION unless the check is IN_REVIEW (a parallel decision loses).',
  })
  async approve(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: ApproveCheckDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.approve(checkId, dto, await this.actor(admin));
  }

  @Post('checks/:checkId/reject')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_DECIDE)
  @ApiOperation({ summary: 'Reject a check in review (remarks required)' })
  async reject(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: RemarksDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.reject(checkId, dto.remarks, await this.actor(admin));
  }

  @Post('checks/:checkId/recheck')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_DECIDE)
  @ApiOperation({
    summary:
      'Re-verify an approved check (APPROVED back to IN_REVIEW; the worker stops counting as verified at once)',
  })
  async recheck(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: RemarksDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.recheck(checkId, dto.remarks, await this.actor(admin));
  }

  @Get('documents/:documentId/link')
  @Permissions(PermissionCode.VERIFICATION_DOCUMENT_VIEW)
  @ApiOperation({
    summary: 'Short-lived signed link to open a KYC document (every issue is audited)',
    description: 'The storage path is never returned. Do not log or share the link.',
  })
  async documentLink(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<DocumentLinkResponse> {
    return this.verification.documentLink(documentId, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<VerificationActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}

@ApiTags('Admin - Verification')
@ApiBearerAuth()
@ApiExtraModels(
  WorkerVerificationResponse,
  AdminWorkerVerificationResponse,
  DocumentUploadResponse,
  DocumentLinkResponse,
  RequirementsResponse,
  QueueItem,
)
@RequireUserType('ADMIN')
@Controller({ path: 'admin/workers/:workerId/verification', version: '1' })
export class AdminWorkerVerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get()
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: "A worker's checks, document metadata and full history" })
  get(
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.adminGetWorker(workerId);
  }
}
