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
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AddNoteDto,
  AdminWorkerVerificationResponse,
  ApproveCheckDto,
  CHECK_TYPES,
  DocumentDetailsDto,
  DocumentLinkResponse,
  DocumentUploadResponse,
  QueueItem,
  ReassignReviewDto,
  RejectCheckDto,
  ReleaseReviewDto,
  RemarksDto,
  RequestDocumentUploadDto,
  RequirementsResponse,
  SetRequirementsDto,
  SignOffDto,
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
  @ApiModelResponse(WorkerVerificationResponse)
  @ApiOperation({
    summary: 'My verification status (FR-VER-012)',
    description:
      'Overall level and each check with its status. Rejection remarks are shown so I can resubmit. Documents appear as metadata only: no storage path, no link.',
  })
  get(@CurrentUser() user: AuthenticatedUser): Promise<WorkerVerificationResponse> {
    return this.verification.getMine(user.userId);
  }

  @Post('checks/:checkType/documents')
  @ApiModelResponse(DocumentUploadResponse, { status: 201 })
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
  @ApiModelResponse(WorkerVerificationResponse)
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
  @ApiModelResponse(WorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit one check for review',
    description:
      'Identity, address and police checks need an uploaded document; emergency-contact and previous-employment checks need that data in my profile (422 CHECK_INCOMPLETE otherwise). Optional body: documentNumber (only the last four characters are kept) and expiresOn (a future date; required later for licence and police clearance). Repeating while it waits for review changes nothing; 409 CHECK_ALREADY_APPROVED once approved; 409 CHECK_DISQUALIFIED after a disqualifying rejection.',
  })
  submit(
    @Param('checkType', new ParseEnumPipe(CHECK_TYPES)) checkType: CheckType,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DocumentDetailsDto,
  ): Promise<WorkerVerificationResponse> {
    return this.verification.submitCheck(user.userId, checkType, dto);
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
  @ApiPageResponse(QueueItem)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({
    summary: 'Verification queue, oldest submission first (paginated)',
    description:
      'Filters: status, checkType, categoryId, search (worker name), assignedTo=me (My Reviews, from the token) or reviewerId. Order: check submission time, then id.',
  })
  async queue(
    @Query() query: VerificationQueueQuery,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<Page<QueueItem>> {
    return this.verification.queue(query, await this.actor(admin));
  }

  @Get('requirements')
  @ApiModelResponse(RequirementsResponse)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: 'Checks required for a worker to count as verified' })
  requirements(): Promise<RequirementsResponse> {
    return this.verification.getRequirements();
  }

  @Put('requirements')
  @ApiModelResponse(RequirementsResponse)
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
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({
    summary:
      'Claim a check for review (SUBMITTED to IN_REVIEW; persists the reviewer and claim time)',
    description:
      'Repeating on my own claim changes nothing. 409 CHECK_ALREADY_ASSIGNED when another reviewer holds it; there is no reassignment (no rule is defined).',
  })
  async startReview(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.startReview(checkId, await this.actor(admin));
  }

  @Post('checks/:checkId/approve')
  @ApiModelResponse(AdminWorkerVerificationResponse)
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
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_DECIDE)
  @ApiOperation({
    summary: 'Reject a check in review with an approved reason code',
    description:
      'Body: reasonCode (BLURRY_IMAGE, DOCUMENT_EXPIRED, NAME_MISMATCH, INCOMPLETE_DOCUMENT, INVALID_DOCUMENT_TYPE, SUSPECTED_TAMPERING, UNVERIFIABLE_REFERENCE, CRIMINAL_RECORD_DISQUALIFIED, OTHER) and remarks (mandatory for OTHER, optional otherwise). The reviewer who claimed the check (or a supervisor) decides: 409 CHECK_NOT_ASSIGNED_TO_YOU otherwise. CRIMINAL_RECORD_DISQUALIFIED and SUSPECTED_TAMPERING are terminal.',
  })
  async reject(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: RejectCheckDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.reject(checkId, dto, await this.actor(admin));
  }

  @Post('checks/:checkId/release-review')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({
    summary: 'Release a claimed check back to the queue (IN_REVIEW to SUBMITTED)',
    description:
      'The claiming reviewer, or a supervisor holding verification.reassign. 409 CHECK_NOT_CLAIMED, 409 CHECK_NOT_ASSIGNED_TO_YOU. A claim idle for 30 minutes is released automatically.',
  })
  async releaseReview(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: ReleaseReviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.releaseReview(checkId, dto, await this.actor(admin));
  }

  @Post('checks/:checkId/reassign-review')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_REASSIGN)
  @ApiOperation({
    summary: 'Give a check in review to another reviewer (supervisors)',
    description:
      'Body: reviewerUserId (an active admin holding verification.review), reason. 422 REVIEWER_NOT_ELIGIBLE.',
  })
  async reassignReview(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: ReassignReviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.reassignReview(checkId, dto, await this.actor(admin));
  }

  @Post('checks/:checkId/notes')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({
    summary: 'Add a reviewer note or a call note to a check in review (staff only)',
    description:
      'Body: kind (CALL or REVIEW) and body. Never shown to the worker. Counts as reviewer activity. Previous-employment approval needs at least one CALL note.',
  })
  async addNote(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.addNote(checkId, dto, await this.actor(admin));
  }

  @Put('checks/:checkId/document-details')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({
    summary:
      'Record the document number (last four characters kept) and validity end for a check in review',
    description:
      'Licence and police clearance need expiresOn (and police clearance the reference number) before they can be approved: 422 APPROVAL_REQUIREMENTS_MISSING.',
  })
  async setDocumentDetails(
    @Param('checkId', ParseUUIDPipe) checkId: string,
    @Body() dto: DocumentDetailsDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.setDocumentDetails(checkId, dto, await this.actor(admin));
  }

  @Post('checks/:checkId/recheck')
  @ApiModelResponse(AdminWorkerVerificationResponse)
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
  @ApiModelResponse(DocumentLinkResponse)
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
    return { userId: admin.userId, roles: access.roles, permissions: access.permissions };
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
  constructor(
    private readonly verification: VerificationService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @Permissions(PermissionCode.VERIFICATION_REVIEW)
  @ApiOperation({ summary: "A worker's checks, document metadata and full history" })
  get(
    @Param('workerId', ParseUUIDPipe) workerId: string,
  ): Promise<AdminWorkerVerificationResponse> {
    return this.verification.adminGetWorker(workerId);
  }

  @Post('sign-off')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.VERIFICATION_SIGNOFF)
  @ApiOperation({
    summary:
      'Final verification sign-off (every required check approved, then a supervisor accepts the worker)',
    description:
      'Repeating changes nothing and notifies nothing twice. 409 NOT_FULLY_VERIFIED, 409 WORKER_DISQUALIFIED, 422 PROFILE_NOT_SUBMITTED. It does not activate the worker.',
  })
  async signOff(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Body() dto: SignOffDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.verification.signOff(workerId, dto, {
      userId: admin.userId,
      roles: access.roles,
      permissions: access.permissions,
    });
  }
}

@ApiTags('Admin - Verification')
@ApiBearerAuth()
@ApiExtraModels(AdminWorkerVerificationResponse)
@RequireUserType('ADMIN')
@Controller({ path: 'admin/workers/:workerId', version: '1' })
export class AdminWorkerActivationController {
  constructor(
    private readonly verification: VerificationService,
    private readonly users: UsersService,
  ) {}

  @Post('activate')
  @ApiModelResponse(AdminWorkerVerificationResponse)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.WORKER_ACTIVATE)
  @ApiOperation({
    summary: 'Activate a signed-off worker: live in search and matching',
    description:
      'Needs the sign-off (409 NOT_SIGNED_OFF), every required check still approved, one service category, one service area, the criminal self-declaration, an active account and no blacklisting (422 ACTIVATION_REQUIREMENTS_MISSING lists what is missing). Repeating changes nothing.',
  })
  async activate(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWorkerVerificationResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.verification.activate(workerId, {
      userId: admin.userId,
      roles: access.roles,
      permissions: access.permissions,
    });
  }
}
