import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PageQueryDto } from '../../common/pagination/pagination';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminBookingListQuery,
  AdminCreateBookingDto,
  AdminBookingView,
  BOOKING_ACTIONS,
  BookingActionDto,
  BookingDetailView,
  BookingFilterQuery,
  CustomerBookingDetailView,
  CustomerBookingView,
  RebookDto,
  ChainEntryView,
  ProposeSlotDto,
  BookingView,
  CreateBookingDto,
  WorkerBookingView,
} from './dto/booking.dto';
import type { BookingAction } from './dto/booking.dto';
import { BookingService } from './booking.service';

function assertIdempotencyKey(key: string | undefined): void {
  if (key !== undefined && !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) {
    throw new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field: 'Idempotency-Key', messages: ['must be 8-100 letters, digits or _ . : -'] }],
    );
  }
}

const ACTION_DOC =
  'Actions: match (admin), schedule, decline (worker/admin), reopen-matching, interview-complete, confirm-worker, start, complete, cancel. Each is one permitted transition of the booking state model; 409 INVALID_TRANSITION otherwise, 403 ACTION_NOT_ALLOWED when the caller may never do it. Repeating an action whose result already holds changes nothing.';

/** The worker's feed of jobs waiting for an answer (PRD 6.3). */
@ApiTags('Worker bookings')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/opportunities', version: '1' })
export class WorkerOpportunitiesController {
  constructor(
    private readonly bookings: BookingService,
    private readonly workers: WorkersService,
  ) {}

  @Get()
  @ApiPageResponse(WorkerBookingView)
  @ApiOperation({
    summary: 'Jobs matched to me that wait for my accept or decline (newest first, paginated)',
    description:
      'Each item is the privacy-safe requirement summary with respondBy (when staff configured a deadline). An opportunity is a booking offered to me: its id is the booking id, and the full detail is GET /workers/me/bookings/{id} (same fields; there is no separate /opportunities/{id}). Accept or decline through POST /workers/me/bookings/{id}/accept|decline.',
  })
  async list(
    @Query() query: PageQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerBookingView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.opportunitiesForWorker(ref.workerId, query);
  }
}

/** A customer's own bookings (FRD FM-06). Every lookup is scoped to the signed-in customer. */
@ApiTags('Bookings')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'bookings', version: '1' })
export class BookingsController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  @ApiModelResponse(BookingDetailView, { status: 201 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. Repeating the same request with the same key returns the first booking (200); the same key with a different request is 409.',
  })
  @ApiOperation({
    summary: 'Create a booking request (NEW_REQUEST, or MATCHED when an eligible worker is chosen)',
    description:
      'Without workerId this is the customer asking staff to find a worker (admin matching, offered when GET /search/workers answers canRequestAdminMatching): the booking is a NEW_REQUEST and staff get a BOOKING_NEEDS_MATCH alert. 422 CATEGORY_NOT_AVAILABLE / AREA_NOT_AVAILABLE / WORKER_NOT_ELIGIBLE, 409 DUPLICATE_BOOKING for a second open booking with the same worker and service.',
  })
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingDetailView> {
    assertIdempotencyKey(key);
    const { booking, created } = await this.bookings.create(user.userId, dto, key);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return booking;
  }

  @Get()
  @ApiPageResponse(CustomerBookingView)
  @ApiOperation({
    summary: 'My bookings, newest first (paginated)',
    description:
      'Each item adds `worker` (display name and photo once the interview stage is reached), `allowedActions` (what I can do now) and `rating` (rated / eligible). See GET /bookings/history for finished bookings with filters.',
  })
  list(
    @Query() query: BookingFilterQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<CustomerBookingView>> {
    return this.bookings.listMine(user.userId, query);
  }

  @Post('rebook')
  @ApiModelResponse(CustomerBookingDetailView, { status: 201 })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. Repeating the same request with the same key returns the first new booking (200).',
  })
  @ApiOperation({
    summary: 'Hire the same worker again for the same requirement (creates a NEW booking)',
    description:
      'Body: bookingId (my COMPLETED booking; `rebook` in its allowedActions) and an optional startDate. Goes through normal booking creation: 422 WORKER_NOT_ELIGIBLE, 409 WORKER_UNAVAILABLE, 409 DUPLICATE_BOOKING, 422 CATEGORY_NOT_AVAILABLE / AREA_NOT_AVAILABLE / ENGAGEMENT_NOT_OFFERED apply again. 409 REBOOK_NOT_ALLOWED for any other status; 404 for a booking that is not mine. Payment, attendance, rating and history are not copied.',
  })
  async rebook(
    @Body() dto: RebookDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingDetailView> {
    assertIdempotencyKey(key);
    const { booking, created } = await this.bookings.rebook(user.userId, dto, key);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return booking;
  }

  @Get(':bookingId')
  @ApiModelResponse(CustomerBookingDetailView)
  @ApiOperation({ summary: "One of my bookings with its status timeline (404 for anyone else's)" })
  get(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerBookingDetailView> {
    return this.bookings.getMine(user.userId, bookingId);
  }

  @Get(':bookingId/replacement-chain')
  @ApiModelResponse(ChainEntryView, { isArray: true })
  @ApiOperation({
    summary: 'The replacement chain this booking belongs to, oldest first (404 for anyone else)',
  })
  chain(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ChainEntryView[]> {
    return this.bookings.chain(bookingId, { kind: 'CUSTOMER', userId: user.userId });
  }

  @Idempotent()
  @Post(':bookingId/slot-proposal/:answer')
  @ApiModelResponse(BookingDetailView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept (answer = accept) or keep the original time (answer = reject) for the time the worker proposed',
    description:
      '409 NO_SLOT_PROPOSAL when nothing is proposed; 404 for any booking that is not mine.',
  })
  answerSlot(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('answer', new ParseEnumPipe(['accept', 'reject'])) answer: 'accept' | 'reject',
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BookingDetailView> {
    return this.bookings.answerSlotProposal(bookingId, answer === 'accept', {
      kind: 'CUSTOMER',
      userId: user.userId,
    });
  }

  @Idempotent()
  @Post(':bookingId/:action')
  @ApiModelResponse(BookingDetailView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Perform a booking action as the customer', description: ACTION_DOC })
  act(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('action', new ParseEnumPipe(BOOKING_ACTIONS)) action: BookingAction,
    @Body() dto: BookingActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BookingDetailView> {
    return this.bookings.act(bookingId, action, dto, { kind: 'CUSTOMER', userId: user.userId });
  }
}

/** The worker's job opportunities (FRD FM-08): the requirement summary only, never the customer. */
@ApiTags('Bookings')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/bookings', version: '1' })
export class WorkerBookingsController {
  constructor(
    private readonly bookings: BookingService,
    private readonly workers: WorkersService,
  ) {}

  @Get()
  @ApiPageResponse(WorkerBookingView)
  @ApiOperation({ summary: 'Bookings offered to or held by me (paginated)' })
  async list(
    @Query() query: BookingFilterQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerBookingView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.listForWorker(ref.workerId, query);
  }

  @Get(':bookingId')
  @ApiModelResponse(WorkerBookingView)
  @ApiOperation({
    summary:
      'One booking offered to or held by me (404 for any other) - also the opportunity detail',
    description:
      'Canonical detail for an item of GET /workers/me/opportunities (same id and fields): available while the offer is open, after I accept it, and for a cancelled one (status CANCELLED). 404 BOOKING_NOT_FOUND for another worker, an unknown id, or after I declined. Requirement summary only: no customer identity, address or contact.',
  })
  async get(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerBookingView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.getForWorker(ref.workerId, bookingId);
  }

  @Idempotent()
  @Put(':bookingId/slot-proposal')
  @ApiModelResponse(WorkerBookingView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Propose a different interview/trial time (the customer answers)',
    description:
      'Only while the interview/trial is scheduled and the booking is mine. The scheduled time stays until the customer accepts. 409 INVALID_TRANSITION otherwise; 400 for a time in the past or the time already scheduled.',
  })
  async proposeSlot(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: ProposeSlotDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerBookingView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.proposeSlot(ref.workerId, bookingId, dto);
  }

  @Idempotent()
  @Post(':bookingId/:action')
  @ApiModelResponse(WorkerBookingView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Perform a booking action as the worker', description: ACTION_DOC })
  async act(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('action', new ParseEnumPipe(BOOKING_ACTIONS)) action: BookingAction,
    @Body() dto: BookingActionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerBookingView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    await this.bookings.act(bookingId, action, dto, {
      kind: 'WORKER',
      userId: user.userId,
      workerId: ref.workerId,
    });
    return this.bookings.getForWorker(ref.workerId, bookingId).catch((error: unknown) => {
      // After a decline the worker no longer holds the booking.
      if (error instanceof DomainException && error.getStatus() === Number(HttpStatus.NOT_FOUND)) {
        return this.declinedView(bookingId);
      }
      throw error;
    });
  }

  private async declinedView(bookingId: string): Promise<WorkerBookingView> {
    const summary = await this.bookings.getSummary(bookingId);
    return { id: summary.id, status: summary.status } as WorkerBookingView;
  }
}

/** Staff-side booking management (FRD FM-14/FR-WD-007): match, schedule, confirm, cancel through the same state machine. */
@ApiTags('Admin - Bookings')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/bookings', version: '1' })
export class AdminBookingsController {
  constructor(
    private readonly bookings: BookingService,
    private readonly users: UsersService,
  ) {}

  @Post()
  @ApiModelResponse(BookingDetailView, { status: 201 })
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Create a booking request on behalf of a customer (audited as an admin action)',
    description:
      'Same rules as the customer request, plus customerId. 404 CUSTOMER_NOT_FOUND, 409 CUSTOMER_NOT_ACTIVE.',
  })
  async create(
    @Body() dto: AdminCreateBookingDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingDetailView> {
    assertIdempotencyKey(key);
    const access = await this.users.getAccess(admin.userId);
    const { customerId, ...request } = dto;
    const { booking, created } = await this.bookings.createForCustomer(
      customerId,
      request,
      { userId: admin.userId, roles: access.roles },
      key,
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return booking;
  }

  @Get()
  @ApiPageResponse(BookingView)
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({
    summary: 'All bookings, newest first (paginated, filter by status/customer/worker)',
  })
  list(@Query() query: AdminBookingListQuery): Promise<Page<BookingView>> {
    return this.bookings.adminList(query);
  }

  @Get(':bookingId')
  @ApiModelResponse(AdminBookingView)
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({ summary: 'A booking with its full timeline and actors' })
  get(@Param('bookingId', ParseUUIDPipe) bookingId: string): Promise<AdminBookingView> {
    return this.bookings.adminGet(bookingId);
  }

  @Get(':bookingId/replacement-chain')
  @ApiModelResponse(ChainEntryView, { isArray: true })
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({ summary: 'The replacement chain of a booking with the worker of each link' })
  chain(@Param('bookingId', ParseUUIDPipe) bookingId: string): Promise<ChainEntryView[]> {
    return this.bookings.chain(bookingId, { kind: 'ADMIN' });
  }

  @Idempotent()
  @Post(':bookingId/slot-proposal/:answer')
  @ApiModelResponse(BookingDetailView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Answer the time a worker proposed, on the customer behalf (audited)' })
  async answerSlot(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('answer', new ParseEnumPipe(['accept', 'reject'])) answer: 'accept' | 'reject',
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<BookingDetailView> {
    const access = await this.users.getAccess(admin.userId);
    return this.bookings.answerSlotProposal(bookingId, answer === 'accept', {
      kind: 'ADMIN',
      userId: admin.userId,
      roles: access.roles,
    });
  }

  @Idempotent()
  @Post(':bookingId/:action')
  @ApiModelResponse(AdminBookingView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.BOOKING_MANAGE)
  @ApiOperation({ summary: 'Perform a booking action as staff (audited)', description: ACTION_DOC })
  async act(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('action', new ParseEnumPipe(BOOKING_ACTIONS)) action: BookingAction,
    @Body() dto: BookingActionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminBookingView> {
    const access = await this.users.getAccess(admin.userId);
    await this.bookings.act(bookingId, action, dto, {
      kind: 'ADMIN',
      userId: admin.userId,
      roles: access.roles,
    });
    return this.bookings.adminGet(bookingId);
  }
}
