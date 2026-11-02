import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { AvailabilityModule } from '../availability/availability.module';
import { BookingModule } from '../booking/booking.module';
import { CustomersModule } from '../customers/customers.module';
import { SearchModule } from '../search/search.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShortlistModule } from '../shortlist/shortlist.module';
import { HomeController } from './home.controller';

/** Customer Home aggregate (one call instead of four). Pure composition: owns no tables, nothing depends on it. */
@Module({
  imports: [
    AttendanceModule,
    AvailabilityModule,
    BookingModule,
    CustomersModule,
    NotificationsModule,
    SearchModule,
    ShortlistModule,
  ],
  controllers: [HomeController],
})
export class HomeModule {}
