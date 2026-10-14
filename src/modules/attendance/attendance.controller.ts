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
import { WorkersService } from '../workers/workers.service';
import { AttendanceActor, AttendanceService } from './attendance.service';
import {
  AdminAttendanceView,
  AdminRecordAttendanceDto,
  AttendanceListQuery,
  AttendanceSummaryQuery,
  AttendanceSummaryView,
  AttendanceView,
  CorrectAttendanceDto,
  RaiseExceptionDto,
  RecordAttendanceDto,
} from './dto/attendance.dto';

/** The worker's own attendance entries for a booking they hold. Today only; the date is not a field. */
@ApiTags('Attendance')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/attendance/bookings/:bookingId', version: '1' })
export class WorkerAttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly workers: WorkersService,
  ) {}

  @Idempotent()
  @Post()
  @ApiModelResponse(AttendanceView, { status: 201 })
  @ApiOperation({
    summary: "Record today's attendance status for my active booking",
    description:
      '201 on first record; repeating the same status also answers 201 and changes nothing (one entry per day); a different status for the same day is 409 ATTENDANCE_ALREADY_RECORDED (staff correct it). 409 BOOKING_NOT_ACTIVE; 404 for a booking that is not mine.',
  })
  async record(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: RecordAttendanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.attendance.workerRecord(user.userId, ref.workerId, bookingId, dto);
  }

  @Get()
  @ApiPageResponse(AttendanceView)
  @ApiOperation({ summary: 'Attendance history of my booking, newest date first (paginated)' })
  async list(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<AttendanceView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.attendance.listForWorker(ref.workerId, bookingId, query);
  }

  @Post('check-in')
  @ApiModelResponse(AttendanceView, { status: 201 })
  @ApiOperation({
    summary: 'Check in for today (the server stamps the time)',
    description:
      "Creates today's PRESENT entry or stamps today's PRESENT/LATE one. Repeating it changes nothing. 409 ATTENDANCE_ALREADY_RECORDED when today is ABSENT, EXCEPTION or LEAVE; 409 BOOKING_NOT_ACTIVE; 404 for a booking that is not mine.",
  })
  async checkIn(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.attendance.workerCheck(user.userId, ref.workerId, bookingId, 'IN');
  }

  @Post('check-out')
  @ApiModelResponse(AttendanceView, { status: 201 })
  @ApiOperation({
    summary: 'Check out for today (the server stamps the time)',
    description:
      '409 CHECK_IN_REQUIRED before a check-in today. Repeating it changes nothing. 409 BOOKING_NOT_ACTIVE; 404 for a booking that is not mine.',
  })
  async checkOut(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.attendance.workerCheck(user.userId, ref.workerId, bookingId, 'OUT');
  }

  @Get('summary')
  @ApiModelResponse(AttendanceSummaryView)
  @ApiOperation({
    summary: 'Counts per status for one month of my booking, with the scheduled window',
  })
  async summary(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceSummaryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceSummaryView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.attendance.summaryForWorker(ref.workerId, bookingId, query.month);
  }
}

/** A customer sees the same recorded status as the worker (FR-ON-001) and may raise an exception (FRD FM-09). */
@ApiTags('Attendance')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'attendance/bookings/:bookingId', version: '1' })
export class CustomerAttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @ApiPageResponse(AttendanceView)
  @ApiOperation({ summary: 'Attendance history of my booking, newest date first (paginated)' })
  list(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<AttendanceView>> {
    return this.attendance.listForCustomer(user.userId, bookingId, query);
  }

  @Get('summary')
  @ApiModelResponse(AttendanceSummaryView)
  @ApiOperation({
    summary: 'Counts per status for one month of my booking, with the scheduled window',
  })
  summary(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceSummaryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceSummaryView> {
    return this.attendance.summaryForCustomer(user.userId, bookingId, query.month);
  }

  @Idempotent()
  @Post('exceptions')
  @ApiModelResponse(AttendanceView, { status: 201 })
  @ApiOperation({
    summary: 'Raise an exception for a date the worker did not record',
    description: 'Only when no entry exists for that date (409 otherwise); a note is required.',
  })
  raise(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: RaiseExceptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceView> {
    return this.attendance.customerRaiseException(user.userId, bookingId, dto);
  }
}

/** Staff view, entry and correction (FRD FM-09: "admin can view and correct entries with an audit record"). */
@ApiTags('Admin - Attendance')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminAttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly users: UsersService,
  ) {}

  @Get('attendance/bookings/:bookingId')
  @ApiPageResponse(AdminAttendanceView)
  @Permissions(PermissionCode.ATTENDANCE_VIEW)
  @ApiOperation({ summary: 'Attendance of a booking with the full change history (paginated)' })
  list(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceListQuery,
  ): Promise<Page<AdminAttendanceView>> {
    return this.attendance.adminList(bookingId, query);
  }

  @Get('attendance/bookings/:bookingId/summary')
  @ApiModelResponse(AttendanceSummaryView)
  @Permissions(PermissionCode.ATTENDANCE_VIEW)
  @ApiOperation({ summary: 'Present / absent / exception counts for one month of a booking' })
  summary(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Query() query: AttendanceSummaryQuery,
  ): Promise<AttendanceSummaryView> {
    return this.attendance.summaryForAdmin(bookingId, query.month);
  }

  @Idempotent()
  @Post('attendance/bookings/:bookingId')
  @ApiModelResponse(AttendanceView, { status: 201 })
  @Permissions(PermissionCode.ATTENDANCE_MANAGE)
  @ApiOperation({ summary: 'Record attendance for a date on behalf of the worker (audited)' })
  async record(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Body() dto: AdminRecordAttendanceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AttendanceView> {
    return this.attendance.adminRecord(bookingId, dto, await this.actor(admin));
  }

  @Patch('attendance/:attendanceId')
  @ApiModelResponse(AdminAttendanceView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.ATTENDANCE_MANAGE)
  @ApiOperation({
    summary: 'Correct an entry (reason required; the previous value stays in the history)',
  })
  async correct(
    @Param('attendanceId', ParseUUIDPipe) attendanceId: string,
    @Body() dto: CorrectAttendanceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminAttendanceView> {
    return this.attendance.adminCorrect(attendanceId, dto, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<AttendanceActor> {
    const access = await this.users.getAccess(admin.userId);
    return { kind: 'ADMIN', userId: admin.userId, roles: access.roles };
  }
}
