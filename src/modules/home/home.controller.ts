import { createHash } from 'node:crypto';
import { Controller, Get, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { AppConfigService } from '../../config/app-config.service';
import { CustomerBookingView, WorkerDisplayView } from '../booking/dto/booking.dto';
import { InterviewView } from '../booking/dto/interview.dto';
import { BookingService } from '../booking/booking.service';
import { InterviewService } from '../booking/interview.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ResolveAreaQuery } from '../availability/dto/availability.dto';
import { AttendanceService } from '../attendance/attendance.service';
import { CustomersService } from '../customers/customers.service';
import { ServiceAreasService } from '../availability/service-areas.service';
import { SearchService } from '../search/search.service';
import { TopRatedWorkerView } from '../search/dto/search.dto';
import { ShortlistItemView, ShortlistQuery } from '../shortlist/dto/shortlist.dto';
import { ShortlistService } from '../shortlist/shortlist.service';

const PREVIEW_SIZE = 5;
const TOP_RATED_SIZE = 6;

export const TODAY_ATTENDANCE_STATUSES = [
  'ARRIVED',
  'NOT_ARRIVED',
  'ABSENT',
  'LEAVE',
  'EXCEPTION',
] as const;

/** Today's attendance of the customer's running service (the newest ACTIVE booking). */
export class TodayAttendanceView {
  @ApiProperty() bookingId!: string;
  @ApiProperty({
    enum: TODAY_ATTENDANCE_STATUSES,
    description:
      'ARRIVED = present or late; NOT_ARRIVED = nothing recorded for today yet; ABSENT, LEAVE and EXCEPTION as recorded. LEAVE is not in the app design list.',
  })
  status!: (typeof TODAY_ATTENDANCE_STATUSES)[number];
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The backend attendance status (PRESENT, LATE, ABSENT, LEAVE, EXCEPTION); null when nothing is recorded.',
  })
  attendanceStatus!: string | null;
  @ApiProperty({
    nullable: true,
    type: Date,
    description:
      'Server-stamped check-in time; null when the worker has not checked in (never inferred from the status).',
  })
  arrivedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) workerName!: string | null;
  @ApiProperty({ nullable: true, type: String }) photoUrl!: string | null;
  @ApiProperty() engagement!: string;
}

/** The interview as on the interviews endpoints, plus who it is with (name rules of D-81: first name and last initial). */
export class HomeInterviewView extends InterviewView {
  @ApiProperty({
    type: WorkerDisplayView,
    nullable: true,
    description:
      'The booking worker as the customer may see them (`name`, `displayName`, `initials`, `photo`, `verified`); null when not available.',
  })
  worker!: WorkerDisplayView | null;
}

export class HomeView {
  @ApiProperty({
    type: CustomerBookingView,
    nullable: true,
    description:
      'The most recently created booking that is not finished (COMPLETED, CANCELLED and REPLACED are finished). A customer can hold several; see activeBookingsTotal. `worker` carries name, photo and verified from the interview stage on.',
  })
  activeBooking!: CustomerBookingView | null;
  @ApiProperty({
    description:
      'How many unfinished bookings the customer has (0 when activeBooking is null). activeBooking is the newest of them.',
  })
  activeBookingsTotal!: number;
  @ApiProperty({
    type: HomeInterviewView,
    nullable: true,
    description: 'Next confirmed interview or trial, with the worker.',
  })
  upcomingInterview!: HomeInterviewView | null;
  @ApiProperty({
    type: TodayAttendanceView,
    nullable: true,
    description: 'Null when the customer has no ACTIVE booking.',
  })
  todayAttendance!: TodayAttendanceView | null;
  @ApiProperty({
    type: [TopRatedWorkerView],
    description:
      'Up to 6 best-rated verified workers, in the area of the customer default address when it can be resolved, else anywhere. Empty when nobody has a rating yet.',
  })
  topRated!: TopRatedWorkerView[];
  @ApiProperty() unreadNotifications!: number;
  @ApiProperty({
    type: [ShortlistItemView],
    description: 'The 5 most recently shortlisted workers at most.',
  })
  shortlistPreview!: ShortlistItemView[];
  @ApiProperty({
    description:
      'All entries on the shortlist, not only the preview (independent of the 5-item cap).',
  })
  shortlistTotal!: number;
}

/**
 * Validator of the Home representation. Signed photo links change on every read, so they are left out and replaced by the photo
 * cacheKey; a time bucket of half the link lifetime is added, so a 304 is only ever answered while the links in the client's
 * cached copy are still valid for at least half their lifetime. Everything else is the delivered JSON itself, so any change to
 * a booking, interview, worker or shortlist entry changes the validator.
 */
export function homeEtag(view: HomeView, signedUrlTtlSeconds: number, now = Date.now()): string {
  const json = JSON.stringify(view, function (this: unknown, key: string, value: unknown) {
    const parent = this as Record<string, unknown>;
    if (
      parent &&
      typeof parent === 'object' &&
      'cacheKey' in parent &&
      (key === 'url' || key === 'largeUrl' || key === 'expiresAt')
    ) {
      return undefined;
    }
    return value;
  });
  const bucket = Math.floor(now / Math.max(1000, signedUrlTtlSeconds * 500));
  return `W/"${createHash('sha256').update(`${bucket}:${json}`).digest('hex').slice(0, 32)}"`;
}

@ApiTags('Customer')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'customers/me/home', version: '1' })
export class HomeController {
  constructor(
    private readonly bookings: BookingService,
    private readonly interviews: InterviewService,
    private readonly notifications: NotificationsService,
    private readonly shortlist: ShortlistService,
    private readonly config: AppConfigService,
    private readonly attendance: AttendanceService,
    private readonly search: SearchService,
    private readonly customers: CustomersService,
    private readonly areas: ServiceAreasService,
  ) {}

  private async todayAttendance(userId: string): Promise<TodayAttendanceView | null> {
    const running = await this.bookings.runningServiceForCustomer(userId);
    if (!running) return null;
    const today = await this.attendance.todayOf(running.id);
    const status = !today
      ? 'NOT_ARRIVED'
      : today.status === 'PRESENT' || today.status === 'LATE'
        ? 'ARRIVED'
        : today.status;
    return {
      bookingId: running.id,
      status,
      attendanceStatus: today?.status ?? null,
      arrivedAt: today?.checkInAt ?? null,
      workerName: running.worker?.name ?? null,
      photoUrl: running.worker?.photoUrl ?? null,
      engagement: running.engagement,
    };
  }

  private async topRated(userId: string): Promise<TopRatedWorkerView[]> {
    const where = await this.customers.defaultAreaOf(userId);
    const area = where
      ? await this.areas
          .resolve(Object.assign(new ResolveAreaQuery(), { name: where.area, city: where.city }))
          .catch(() => null)
      : null;
    return this.search.topRated(userId, area?.id, TOP_RATED_SIZE);
  }

  @Get()
  @ApiModelResponse(HomeView)
  @ApiOperation({
    summary:
      'Home screen in one call: active booking, upcoming interview, unread count, shortlist preview',
    description:
      'Personalised: `Cache-Control: private, no-cache` and `Vary: Authorization`. Send `If-None-Match` with the last `ETag` to get 304 while nothing changed. Photo links inside are short-lived: cache the image by `photo.cacheKey`.',
  })
  async home(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HomeView> {
    const [active, interview, unread, shortlist, todayAttendance, topRated] = await Promise.all([
      this.bookings.activeForCustomer(user.userId),
      this.interviews.upcomingForCustomer(user.userId),
      this.notifications.unreadCount(user.userId),
      this.shortlist.list(
        user.userId,
        Object.assign(new ShortlistQuery(), { page: 1, limit: PREVIEW_SIZE }),
      ),
      this.todayAttendance(user.userId),
      this.topRated(user.userId),
    ]);
    const view: HomeView = {
      activeBooking: active.booking,
      activeBookingsTotal: active.total,
      upcomingInterview: interview
        ? { ...interview, worker: await this.bookings.workerDisplayForBooking(interview.bookingId) }
        : null,
      todayAttendance,
      topRated,
      unreadNotifications: unread.unread,
      shortlistPreview: shortlist.data,
      shortlistTotal: shortlist.meta.total,
    };
    // Express answers 304 itself when If-None-Match matches this validator.
    res.setHeader('ETag', homeEtag(view, this.config.profilePhoto.signedUrlTtlSeconds));
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('Vary', 'Authorization');
    return view;
  }
}
