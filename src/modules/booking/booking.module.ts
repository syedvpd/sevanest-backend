import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CustomersModule } from '../customers/customers.module';
import { SearchModule } from '../search/search.module';
import { ServiceCategoriesModule } from '../service-categories/service-categories.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { BookingLifecycleHooks } from './booking-hooks';
import {
  AdminBookingsController,
  BookingsController,
  WorkerBookingsController,
  WorkerOpportunitiesController,
} from './booking.controller';
import {
  AdminInterviewsController,
  BookingInterviewsController,
  CustomerInterviewsController,
  WorkerInterviewsController,
} from './interview.controller';
import { InterviewRepository } from './interview.repository';
import { InterviewService } from './interview.service';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingSweepService } from './booking-sweep.service';

/**
 * Booking: the booking lifecycle (FRD section 4, PROPOSED). Owns the booking tables. Depends on Users, Workers, Service
 * Categories, Availability (areas) and Search (eligibility); Payment, Attendance and Replacement depend on it through
 * `BookingService`, never the reverse (Replacement hooks in through `BookingLifecycleHooks`).
 */
@Module({
  imports: [
    UsersModule,
    CustomersModule,
    WorkersModule,
    ServiceCategoriesModule,
    AvailabilityModule,
    SearchModule,
  ],
  controllers: [
    BookingsController,
    WorkerBookingsController,
    WorkerOpportunitiesController,
    AdminBookingsController,
    BookingInterviewsController,
    CustomerInterviewsController,
    WorkerInterviewsController,
    AdminInterviewsController,
  ],
  providers: [
    BookingRepository,
    InterviewRepository,
    BookingService,
    InterviewService,
    BookingLifecycleHooks,
    BookingSweepService,
  ],
  exports: [BookingService, InterviewService, BookingLifecycleHooks, BookingSweepService],
})
export class BookingModule {}
