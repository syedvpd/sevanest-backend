import { Module } from '@nestjs/common';
import { BookingModule } from '../booking/booking.module';
import { UsersModule } from '../users/users.module';
import { WorkersModule } from '../workers/workers.module';
import {
  AdminAttendanceController,
  CustomerAttendanceController,
  WorkerAttendanceController,
} from './attendance.controller';
import { AttendanceRepository } from './attendance.repository';
import { AttendanceService } from './attendance.service';

/** Attendance: status-based per-date records of an active booking (FRD FM-09). Owns the attendance tables. */
@Module({
  imports: [BookingModule, UsersModule, WorkersModule],
  controllers: [
    WorkerAttendanceController,
    CustomerAttendanceController,
    AdminAttendanceController,
  ],
  providers: [AttendanceRepository, AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
