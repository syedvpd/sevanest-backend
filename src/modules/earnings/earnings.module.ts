import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { AdminEarningsController, WorkerEarningsController } from './earnings.controller';
import { EarningsRepository } from './earnings.repository';
import { EarningsService } from './earnings.service';

/**
 * Earnings reference (FR-WJ-008, DEC-05): staff record wage payments made off-platform; the worker reads them. Owns
 * worker_payment_references. V1 is not payroll, so nothing here moves or calculates money.
 */
@Module({
  imports: [BookingModule, UsersModule, WorkersModule],
  controllers: [WorkerEarningsController, AdminEarningsController],
  providers: [EarningsRepository, EarningsService],
})
export class EarningsModule {}
