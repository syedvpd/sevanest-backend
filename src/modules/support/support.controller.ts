import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminMessageView,
  AdminSupportCategoryView,
  AdminTicketDetailView,
  AdminTicketListQuery,
  AdminTicketView,
  AssignTicketDto,
  CloseTicketDto,
  CreateSupportCategoryDto,
  CreateTicketDto,
  EscalateTicketDto,
  MessageListQuery,
  MessageView,
  MyTicketListQuery,
  PostMessageDto,
  SetPriorityDto,
  StaffMessageDto,
  SupportCategoryView,
  TicketDetailView,
  TicketView,
  UpdateSupportCategoryDto,
} from './dto/support.dto';
import { StaffActor, SupportService } from './support.service';

/** Customers and workers raise and follow their own tickets (FR-SUP-001, FR-ON-003, FR-WJ-010). Every lookup is scoped to the caller. */
@ApiTags('Support')
@ApiBearerAuth()
@RequireUserType('CUSTOMER', 'WORKER')
@Controller({ path: 'support', version: '1' })
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('categories')
  @ApiModelResponse(SupportCategoryView, { isArray: true })
  @ApiOperation({ summary: 'The configured ticket categories that can be chosen' })
  categories(): Promise<SupportCategoryView[]> {
    return this.support.listCategories();
  }

  @Idempotent()
  @Post('tickets')
  @ApiModelResponse(TicketDetailView, { status: 201 })
  @ApiOperation({
    summary: 'Raise a support request or complaint',
    description:
      '422 SUPPORT_CATEGORY_INVALID for an unknown or disabled category. A bookingId must be a booking the caller is a party to (the customer, or the booking worker), otherwise 404 BOOKING_NOT_FOUND.',
  })
  create(
    @Body() dto: CreateTicketDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TicketDetailView> {
    return this.support.create(
      { userId: user.userId, kind: user.type === 'WORKER' ? 'WORKER' : 'CUSTOMER' },
      dto,
    );
  }

  @Get('tickets')
  @ApiPageResponse(TicketView)
  @ApiOperation({ summary: 'My tickets, newest first (paginated)' })
  list(
    @Query() query: MyTicketListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<TicketView>> {
    return this.support.listMine(user.userId, query);
  }

  @Get('tickets/:ticketId')
  @ApiModelResponse(TicketDetailView)
  @ApiOperation({
    summary: 'One of my tickets with its progress (404 for anyone else)',
    description:
      'History shows what happened and when; staff notes and staff identities are never included.',
  })
  get(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TicketDetailView> {
    return this.support.getMine(user.userId, ticketId);
  }

  @Idempotent()
  @Post('tickets/:ticketId/messages')
  @ApiModelResponse(MessageView, { status: 201 })
  @ApiOperation({
    summary: 'Write on one of my open tickets',
    description: "404 for anyone else's ticket; 409 TICKET_CLOSED once it is closed. No HTML.",
  })
  postMessage(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: PostMessageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MessageView> {
    return this.support.postMessage(
      { userId: user.userId, kind: user.type === 'WORKER' ? 'WORKER' : 'CUSTOMER' },
      ticketId,
      dto.body,
    );
  }

  @Get('tickets/:ticketId/messages')
  @ApiPageResponse(MessageView)
  @ApiOperation({
    summary: 'The conversation on one of my tickets (staff internal notes are never included)',
  })
  messages(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Query() query: MessageListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<MessageView>> {
    return this.support.listMessagesMine(user.userId, ticketId, query);
  }
}

/** Staff work the tickets (FR-SUP-003/005). */
@ApiTags('Admin - Support')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/support', version: '1' })
export class AdminSupportController {
  constructor(
    private readonly support: SupportService,
    private readonly users: UsersService,
  ) {}

  @Get('tickets')
  @ApiPageResponse(AdminTicketView)
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({
    summary: 'All tickets (paginated; filter by status, priority, owner, category, booking)',
  })
  list(@Query() query: AdminTicketListQuery): Promise<Page<AdminTicketView>> {
    return this.support.adminList(query);
  }

  @Get('tickets/:ticketId')
  @ApiModelResponse(AdminTicketDetailView)
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({ summary: 'One ticket with the full history including internal notes' })
  get(@Param('ticketId', ParseUUIDPipe) ticketId: string): Promise<AdminTicketDetailView> {
    return this.support.adminGet(ticketId);
  }

  @Post('tickets/:ticketId/assign')
  @ApiModelResponse(AdminTicketDetailView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({
    summary: 'Assign the ticket (to me by default); the first assignment starts work (IN_PROGRESS)',
  })
  async assign(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: AssignTicketDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminTicketDetailView> {
    return this.support.assign(ticketId, dto.assigneeUserId, dto.note, await this.actor(admin));
  }

  @Post('tickets/:ticketId/priority')
  @ApiModelResponse(AdminTicketDetailView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Set the priority (staff only)' })
  async priority(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: SetPriorityDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminTicketDetailView> {
    return this.support.setPriority(ticketId, dto.priority, await this.actor(admin));
  }

  @Post('tickets/:ticketId/escalate')
  @ApiModelResponse(AdminTicketDetailView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({ summary: 'Escalate the ticket (reason required, internal)' })
  async escalate(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: EscalateTicketDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminTicketDetailView> {
    return this.support.escalate(ticketId, dto.reason, await this.actor(admin));
  }

  @Post('tickets/:ticketId/close')
  @ApiModelResponse(AdminTicketDetailView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({
    summary: 'Close the ticket with the resolution (required); a closed ticket is final',
  })
  async close(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: CloseTicketDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminTicketDetailView> {
    return this.support.close(ticketId, dto.resolution, await this.actor(admin));
  }

  @Idempotent()
  @Post('tickets/:ticketId/messages')
  @ApiModelResponse(AdminMessageView, { status: 201 })
  @Permissions(PermissionCode.SUPPORT_MANAGE)
  @ApiOperation({
    summary: 'Reply to the ticket creator, or leave an internal note (`internal: true`)',
    description:
      'A reply notifies the creator; an internal note is staff-only. 409 TICKET_CLOSED. Audited.',
  })
  async staffMessage(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Body() dto: StaffMessageDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminMessageView> {
    return this.support.staffMessage(
      ticketId,
      dto.body,
      dto.internal === true,
      await this.actor(admin),
    );
  }

  @Get('tickets/:ticketId/messages')
  @ApiPageResponse(AdminMessageView)
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({ summary: 'The full conversation including internal notes' })
  adminMessages(
    @Param('ticketId', ParseUUIDPipe) ticketId: string,
    @Query() query: MessageListQuery,
  ): Promise<Page<AdminMessageView>> {
    return this.support.adminListMessages(ticketId, query);
  }

  @Get('categories')
  @ApiModelResponse(AdminSupportCategoryView, { isArray: true })
  @Permissions(PermissionCode.SUPPORT_VIEW)
  @ApiOperation({ summary: 'All ticket categories including disabled ones' })
  categories(): Promise<AdminSupportCategoryView[]> {
    return this.support.adminListCategories();
  }

  @Post('categories')
  @ApiModelResponse(AdminSupportCategoryView, { status: 201 })
  @Permissions(PermissionCode.SUPPORT_CATEGORY_MANAGE)
  @ApiOperation({ summary: 'Add a ticket category (audited)' })
  async createCategory(
    @Body() dto: CreateSupportCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminSupportCategoryView> {
    return this.support.createCategory(dto, await this.actor(admin));
  }

  @Patch('categories/:categoryId')
  @ApiModelResponse(AdminSupportCategoryView)
  @Permissions(PermissionCode.SUPPORT_CATEGORY_MANAGE)
  @ApiOperation({ summary: 'Rename or enable/disable a ticket category (audited)' })
  async updateCategory(
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateSupportCategoryDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminSupportCategoryView> {
    return this.support.updateCategory(categoryId, dto, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<StaffActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
