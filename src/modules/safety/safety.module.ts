import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { AdminSafetyController, SafetyController } from './safety.controller';
import { SafetyService } from './safety.service';

/**
 * Safety: report and block (PRD 9.1). Owns `safety_reports` and `user_blocks`. The block's effect lives in the shared eligibility
 * query (Search), so Search, Matching, Booking, Shortlist and Replacement honour it without depending on this module.
 */
@Module({
  imports: [BookingModule, UsersModule, WorkersModule],
  controllers: [SafetyController, AdminSafetyController],
  providers: [SafetyService],
})
export class SafetyModule {}
