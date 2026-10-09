import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import {
  AdminRatingsController,
  RatingsController,
  WorkerRatingsController,
} from './ratings.controller';
import { CompletedBookingRatingPolicy, RATING_POLICY } from './ratings.policy';
import { RatingsRepository } from './ratings.repository';
import { RatingsService } from './ratings.service';

/**
 * Ratings: customer-to-worker ratings of completed bookings and the per-worker totals (FRD FM-10). Owns `ratings` and
 * `worker_rating_summaries`. Depends on Booking (eligibility), Workers and Users; nothing in Search or Matching depends on it.
 * Eligibility is the RATING_POLICY boundary (Q-58).
 */
@Module({
  imports: [BookingModule, UsersModule, WorkersModule],
  controllers: [RatingsController, WorkerRatingsController, AdminRatingsController],
  providers: [
    RatingsRepository,
    RatingsService,
    { provide: RATING_POLICY, useClass: CompletedBookingRatingPolicy },
  ],
  exports: [RatingsService],
})
export class RatingsModule {}
