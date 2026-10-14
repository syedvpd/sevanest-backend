import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { PaymentModule } from '../payment/payment.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

/** Customer service history: composes Booking (finished bookings, counts) and Payment (money held). Owns no tables; nothing depends on it. */
@Module({
  imports: [BookingModule, PaymentModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}
