import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { MatchingModule } from '../matching/matching.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { AdminReplacementsController, ReplacementsController } from './replacement.controller';
import { ActiveBookingReplacementPolicy, REPLACEMENT_POLICY } from './replacement.policy';
import { ReplacementRepository } from './replacement.repository';
import { ReplacementService } from './replacement.service';

/**
 * Replacement: the replacement workflow. Owns the replacement table. Depends on Booking (state moves, new booking), Matching
 * (alternative workers), Workers and Users; Booking learns about cancellations through `BookingLifecycleHooks`, not by
 * importing this module. Eligibility is the REPLACEMENT_POLICY boundary (Q-09).
 */
@Module({
  imports: [BookingModule, MatchingModule, UsersModule, WorkersModule],
  controllers: [ReplacementsController, AdminReplacementsController],
  providers: [
    ReplacementRepository,
    ReplacementService,
    { provide: REPLACEMENT_POLICY, useClass: ActiveBookingReplacementPolicy },
  ],
  exports: [ReplacementService],
})
export class ReplacementModule {}
