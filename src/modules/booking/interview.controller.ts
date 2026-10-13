import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminInterviewListQuery,
  CancelInterviewDto,
  CompleteInterviewDto,
  DeclineInterviewDto,
  InterviewListQuery,
  InterviewView,
  ProposeInterviewDto,
  RequestInterviewDto,
  RescheduleInterviewDto,
} from './dto/interview.dto';
import { InterviewService } from './interview.service';

const FLOW =
  'States: REQUESTED -> CONFIRMED | DECLINED | RESCHEDULE_PROPOSED; open sessions can be CANCELLED; a CONFIRMED session is COMPLETED with an outcome. One session is open per booking. 404 for a booking or session that is not yours, 409 INVALID_INTERVIEW_STATE for a step that is not allowed now.';

/** Customer side: request an interview or trial for a booking, then manage it (PRD 5.4). */
@ApiTags('Interviews and trials')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'bookings/:bookingId/interviews', version: '1' })
export class BookingInterviewsController {
  constructor(private readonly interviews: InterviewService) {}

  @Get()
  @ApiModelResponse(InterviewView, { isArray: true })
  @ApiOperation({ summary: 'The interviews and trials of one of my bookings, oldest first' })
  list(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView[]> {
    return this.interviews.listForCustomer(user.userId, bookingId);
  }
}

@ApiTags('Interviews and trials')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'interviews', version: '1' })
export class CustomerInterviewsController {
  constructor(private readonly interviews: InterviewService) {}

  private actor(user: AuthenticatedUser) {
    return { kind: 'CUSTOMER' as const, userId: user.userId };
  }

  @Idempotent()
  @Post()
  @ApiModelResponse(InterviewView, { status: 201 })
  @ApiOperation({
    summary: 'Request an interview or trial with the matched worker at a preferred time',
    description: `Only for a booking with a matched worker that is MATCHED or has a finished interview/trial (a further round). ${FLOW}`,
  })
  request(
    @Body() dto: RequestInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.request(dto.bookingId, dto, this.actor(user));
  }

  @Get()
  @ApiPageResponse(InterviewView)
  @ApiOperation({
    summary:
      'All my interviews and trials across bookings (newest first, paginated; filter by status or type)',
  })
  list(
    @Query() query: InterviewListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<InterviewView>> {
    return this.interviews.pageForCustomer(user.userId, query);
  }

  @Get(':interviewId')
  @ApiModelResponse(InterviewView)
  @ApiOperation({ summary: 'One of my interviews or trials (404 for anyone else)' })
  get(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.get(id, this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/reschedule')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask for another time: the session returns to REQUESTED for the worker to answer',
    description: FLOW,
  })
  reschedule(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.reschedule(id, dto, this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/accept-proposal')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the other time the worker proposed - it becomes the agreed time',
  })
  acceptProposal(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.acceptProposal(id, this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/reject-proposal')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Keep the original time instead of the one the worker proposed' })
  rejectProposal(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.rejectProposal(id, this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/cancel')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open interview or trial (reason required)' })
  cancel(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: CancelInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.cancel(id, dto, this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/complete')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'It took place: record the outcome. The booking moves on so the worker can be confirmed',
    description: FLOW,
  })
  complete(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: CompleteInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.complete(id, dto, this.actor(user));
  }
}

/** Worker side: see the requests and answer them (PRD 6.3 "Interview/trial schedule"). */
@ApiTags('Worker interviews and trials')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/interviews', version: '1' })
export class WorkerInterviewsController {
  constructor(
    private readonly interviews: InterviewService,
    private readonly workers: WorkersService,
  ) {}

  private async actor(user: AuthenticatedUser) {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return { kind: 'WORKER' as const, userId: user.userId, workerId: ref.workerId };
  }

  @Get()
  @ApiPageResponse(InterviewView)
  @ApiOperation({
    summary: 'My interviews and trials (newest first, paginated; filter by status or type)',
    description: 'Only the schedule and status: the customer is not identified.',
  })
  async list(
    @Query() query: InterviewListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<InterviewView>> {
    return this.interviews.listForWorker((await this.actor(user)).workerId, query);
  }

  @Get(':interviewId')
  @ApiModelResponse(InterviewView)
  @ApiOperation({ summary: 'One of my interviews or trials (404 for anyone else)' })
  async get(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.get(id, await this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/accept')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the requested time: the interview or trial is scheduled',
    description: FLOW,
  })
  async accept(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.accept(id, await this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/decline')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline the request (reason required)' })
  async decline(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: DeclineInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.decline(id, dto, await this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/propose')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Propose a different time; the customer accepts or keeps the original' })
  async propose(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: ProposeInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.propose(id, dto, await this.actor(user));
  }

  @Idempotent()
  @Post(':interviewId/cancel')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open interview or trial (reason required)' })
  async cancel(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: CancelInterviewDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.cancel(id, dto, await this.actor(user));
  }
}

/** Staff side: search, and act for either party (audited). */
@ApiTags('Admin - Interviews and trials')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminInterviewsController {
  constructor(
    private readonly interviews: InterviewService,
    private readonly users: UsersService,
  ) {}

  private async actor(admin: AuthenticatedUser) {
    const access = await this.users.getAccess(admin.userId);
    return { kind: 'ADMIN' as const, userId: admin.userId, roles: access.roles };
  }

  @Get('interviews')
  @ApiPageResponse(InterviewView)
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({
    summary: 'All interviews and trials (paginated; filter by status, type, booking)',
  })
  search(@Query() query: AdminInterviewListQuery): Promise<Page<InterviewView>> {
    return this.interviews.adminSearch(query);
  }

  @Get('bookings/:bookingId/interviews')
  @ApiModelResponse(InterviewView, { isArray: true })
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({ summary: 'The interviews and trials of a booking, oldest first' })
  forBooking(@Param('bookingId', ParseUUIDPipe) bookingId: string): Promise<InterviewView[]> {
    return this.interviews.listForAdmin(bookingId);
  }

  @Get('interviews/:interviewId')
  @ApiModelResponse(InterviewView)
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({ summary: 'One interview or trial' })
  async get(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.get(id, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews')
  @ApiModelResponse(InterviewView, { status: 201 })
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({
    summary: 'Request an interview or trial on behalf of the customer (audited)',
    description: FLOW,
  })
  async request(
    @Body() dto: RequestInterviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.request(dto.bookingId, dto, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/confirm')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Confirm the requested time on behalf of the worker (audited)' })
  async confirm(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.accept(id, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/reschedule')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Change the preferred time on behalf of the customer' })
  async reschedule(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleInterviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.reschedule(id, dto, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/accept-proposal')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Accept the worker proposed time on behalf of the customer' })
  async acceptProposal(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.acceptProposal(id, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/reject-proposal')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Keep the original time on behalf of the customer' })
  async rejectProposal(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.rejectProposal(id, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/cancel')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Cancel an open interview or trial (reason required, audited)' })
  async cancel(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: CancelInterviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.cancel(id, dto, await this.actor(admin));
  }

  @Idempotent()
  @Post('interviews/:interviewId/complete')
  @ApiModelResponse(InterviewView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Record the outcome on behalf of the customer (audited)' })
  async complete(
    @Param('interviewId', ParseUUIDPipe) id: string,
    @Body() dto: CompleteInterviewDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<InterviewView> {
    return this.interviews.complete(id, dto, await this.actor(admin));
  }
}
