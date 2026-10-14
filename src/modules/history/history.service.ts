import { Injectable } from '@nestjs/common';
import type { Page } from '../../common/pagination/pagination';
import {
  BookingHistoryItemView,
  BookingHistoryQuery,
  BookingHistorySummaryQuery,
  BookingHistorySummaryView,
} from '../booking/dto/booking.dto';
import { BookingService } from '../booking/booking.service';
import { PaymentService } from '../payment/payment.service';

/**
 * The customer's service history (D-78): finished bookings from Booking, enriched with what was paid from Payment; totals
 * from both. Pure composition: owns no tables, every call is scoped to the signed-in customer.
 */
@Injectable()
export class HistoryService {
  constructor(
    private readonly bookings: BookingService,
    private readonly payments: PaymentService,
  ) {}

  async list(
    customerUserId: string,
    query: BookingHistoryQuery,
  ): Promise<Page<BookingHistoryItemView>> {
    const page = await this.bookings.historyMine(customerUserId, query);
    const held = await this.payments.heldByBooking(page.data.map((b) => b.id));
    return {
      data: page.data.map((b) => ({ ...b, amountPaidMinor: held.get(b.id) ?? 0, currency: 'INR' })),
      meta: page.meta,
    };
  }

  async summary(
    customerUserId: string,
    query: BookingHistorySummaryQuery,
  ): Promise<BookingHistorySummaryView> {
    const [counts, spent] = await Promise.all([
      this.bookings.historyCountsMine(customerUserId, query),
      this.payments.heldForCustomer(customerUserId, query),
    ]);
    return {
      ...counts,
      totalSpentMinor: spent,
      currency: 'INR',
      year: query.year ?? null,
      category: query.category ?? null,
    };
  }
}
