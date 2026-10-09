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
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminBookingListQuery,
  AdminBookingView,
  BOOKING_ACTIONS,
  BookingActionDto,
  BookingDetailView,
  BookingListQuery,
  BookingView,
  CreateBookingDto,
  WorkerBookingView,
} from './dto/booking.dto';
import type { BookingAction } from './dto/booking.dto';
import { BookingService } from './booking.service';

const ACTION_DOC =
  'Actions: match (admin), schedule, decline (worker/admin), reopen-matching, interview-complete, confirm-worker, start, complete, cancel. Each is one permitted transition of the booking state model; 409 INVALID_TRANSITION otherwise, 403 ACTION_NOT_ALLOWED when the caller may never do it. Repeating an action whose result already holds changes nothing.';

/** A customer's own bookings (FRD FM-06). Every lookup is scoped to the signed-in customer. */
@ApiTags('Bookings')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'bookings', version: '1' })
export class BookingsController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional. Repeating the same request with the same key returns the first booking (200); the same key with a different request is 409.',
  })
  @ApiOperation({
    summary: 'Create a booking request (NEW_REQUEST, or MATCHED when an eligible worker is chosen)',
    description:
      '422 CATEGORY_NOT_AVAILABLE / AREA_NOT_AVAILABLE / WORKER_NOT_ELIGIBLE, 409 DUPLICATE_BOOKING for a second open booking with the same worker and service.',
  })
  async create(
    @Body() dto: CreateBookingDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BookingDetailView> {
    if (key !== undefined && !/^[A-Za-z0-9_.:-]{8,100}$/.test(key)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'Idempotency-Key', messages: ['must be 8-100 letters, digits or _ . : -'] }],
      );
    }
    const { booking, created } = await this.bookings.create(user.userId, dto, key);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return booking;
  }

  @Get()
  @ApiOperation({ summary: 'My bookings, newest first (paginated)' })
  list(
    @Query() query: BookingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<BookingView>> {
    return this.bookings.listMine(user.userId, query);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: "One of my bookings with its status timeline (404 for anyone else's)" })
  get(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BookingDetailView> {
    return this.bookings.getMine(user.userId, bookingId);
  }

  @Post(':bookingId/:action')
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
  @ApiOperation({ summary: 'Bookings offered to or held by me (paginated)' })
  async list(
    @Query() query: BookingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerBookingView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.listForWorker(ref.workerId, query);
  }

  @Get(':bookingId')
  @ApiOperation({ summary: 'One booking offered to or held by me (404 for any other)' })
  async get(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerBookingView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.bookings.getForWorker(ref.workerId, bookingId);
  }

  @Post(':bookingId/:action')
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

  @Get()
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({
    summary: 'All bookings, newest first (paginated, filter by status/customer/worker)',
  })
  list(@Query() query: AdminBookingListQuery): Promise<Page<BookingView>> {
    return this.bookings.adminList(query);
  }

  @Get(':bookingId')
  @Permissions(PermissionCode.BOOKING_VIEW)
  @ApiOperation({ summary: 'A booking with its full timeline and actors' })
  get(@Param('bookingId', ParseUUIDPipe) bookingId: string): Promise<AdminBookingView> {
    return this.bookings.adminGet(bookingId);
  }

  @Post(':bookingId/:action')
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
