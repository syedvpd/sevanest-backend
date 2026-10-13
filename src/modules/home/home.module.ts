import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ShortlistModule } from '../shortlist/shortlist.module';
import { HomeController } from './home.controller';

/** Customer Home aggregate (one call instead of four). Pure composition: owns no tables, nothing depends on it. */
@Module({
  imports: [BookingModule, NotificationsModule, ShortlistModule],
  controllers: [HomeController],
})
export class HomeModule {}
