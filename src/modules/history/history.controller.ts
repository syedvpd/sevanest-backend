import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import {
  BookingHistoryItemView,
  BookingHistoryQuery,
  BookingHistorySummaryQuery,
  BookingHistorySummaryView,
} from '../booking/dto/booking.dto';
import { HistoryService } from './history.service';

/** The customer's own service history for the History screen. Every lookup is scoped to the signed-in customer. */
@ApiTags('Customer')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'customers/me/booking-history', version: '1' })
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  @ApiPageResponse(BookingHistoryItemView)
  @ApiOperation({
    summary: 'My finished bookings (completed, ended early, cancelled), newest service first',
    description:
      'Filters: year (service start date, else request date, India time), category (code), search (category name or the worker name where the worker is shown), status. Each item also carries amountPaidMinor. 400 for an invalid filter.',
  })
  list(
    @Query() query: BookingHistoryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<BookingHistoryItemView>> {
    return this.history.list(user.userId, query);
  }

  @Get('summary')
  @ApiModelResponse(BookingHistorySummaryView)
  @ApiOperation({
    summary: 'Totals for the history header: services, distinct workers, total spent',
    description:
      'totalServices and distinctWorkers count COMPLETED and REPLACED bookings; totalSpentMinor sums my payments that still hold money (SUCCEEDED, REFUND_PENDING, REFUND_FAILED) over all my bookings matching the year and category. Only my own data.',
  })
  summary(
    @Query() query: BookingHistorySummaryQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BookingHistorySummaryView> {
    return this.history.summary(user.userId, query);
  }
}
