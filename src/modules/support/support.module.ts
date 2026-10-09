import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import { AdminSupportController, SupportController } from './support.controller';
import { SupportRepository } from './support.repository';
import { SupportService } from './support.service';

/**
 * Support: tickets and complaints raised by customers and workers and worked by staff (FRD FM-12). Owns the ticket,
 * ticket history and category tables. Depends on Booking (a ticket may point at the creator's own booking), Workers and Users.
 */
@Module({
  imports: [BookingModule, UsersModule, WorkersModule],
  controllers: [SupportController, AdminSupportController],
  providers: [SupportRepository, SupportService],
  exports: [SupportService],
})
export class SupportModule {}
