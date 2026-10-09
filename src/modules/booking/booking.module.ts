import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { SearchModule } from '../search/search.module';
import { ServiceCategoriesModule } from '../service-categories/service-categories.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { BookingLifecycleHooks } from './booking-hooks';
import {
  AdminBookingsController,
  BookingsController,
  WorkerBookingsController,
} from './booking.controller';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';

/**
 * Booking: the booking lifecycle (FRD section 4, PROPOSED). Owns the booking tables. Depends on Users, Workers, Service
 * Categories, Availability (areas) and Search (eligibility); Payment, Attendance and Replacement depend on it through
 * `BookingService`, never the reverse (Replacement hooks in through `BookingLifecycleHooks`).
 */
@Module({
  imports: [UsersModule, WorkersModule, ServiceCategoriesModule, AvailabilityModule, SearchModule],
  controllers: [BookingsController, WorkerBookingsController, AdminBookingsController],
  providers: [BookingRepository, BookingService, BookingLifecycleHooks],
  exports: [BookingService, BookingLifecycleHooks],
})
export class BookingModule {}
