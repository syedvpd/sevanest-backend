import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { CustomerBookingView } from '../booking/dto/booking.dto';
import { InterviewView } from '../booking/dto/interview.dto';
import { BookingService } from '../booking/booking.service';
import { InterviewService } from '../booking/interview.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ShortlistItemView, ShortlistQuery } from '../shortlist/dto/shortlist.dto';
import { ShortlistService } from '../shortlist/shortlist.service';

const PREVIEW_SIZE = 5;

export class HomeView {
  @ApiProperty({
    type: CustomerBookingView,
    nullable: true,
    description: 'Newest booking that is not finished.',
  })
  activeBooking!: CustomerBookingView | null;
  @ApiProperty({
    type: InterviewView,
    nullable: true,
    description: 'Next confirmed interview or trial.',
  })
  upcomingInterview!: InterviewView | null;
  @ApiProperty() unreadNotifications!: number;
  @ApiProperty({ type: [ShortlistItemView], description: 'The most recently shortlisted workers.' })
  shortlistPreview!: ShortlistItemView[];
  @ApiProperty() shortlistTotal!: number;
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
  ) {}

  @Get()
  @ApiModelResponse(HomeView)
  @ApiOperation({
    summary:
      'Home screen in one call: active booking, upcoming interview, unread count, shortlist preview',
  })
  async home(@CurrentUser() user: AuthenticatedUser): Promise<HomeView> {
    const [activeBooking, upcomingInterview, unread, shortlist] = await Promise.all([
      this.bookings.activeForCustomer(user.userId),
      this.interviews.upcomingForCustomer(user.userId),
      this.notifications.unreadCount(user.userId),
      this.shortlist.list(
        user.userId,
        Object.assign(new ShortlistQuery(), { page: 1, limit: PREVIEW_SIZE }),
      ),
    ]);
    return {
      activeBooking,
      upcomingInterview,
      unreadNotifications: unread.unread,
      shortlistPreview: shortlist.data,
      shortlistTotal: shortlist.meta.total,
    };
  }
}
