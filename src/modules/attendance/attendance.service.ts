import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, skipFor } from '../../common/pagination/pagination';
import { indiaToday, isRealDate } from '../../common/time/india';
import { BookingService } from '../booking/booking.service';
import {
  ActorKindValue,
  AdminAttendanceView,
  AdminRecordAttendanceDto,
  AttendanceListQuery,
  AttendanceStatusValue,
  AttendanceView,
  CorrectAttendanceDto,
  RaiseExceptionDto,
  RecordAttendanceDto,
} from './dto/attendance.dto';
import { AttendanceRecordRow, AttendanceRepository } from './attendance.repository';

export const AttendanceErrorCode = {
  BOOKING_NOT_FOUND: 'BOOKING_NOT_FOUND',
  ATTENDANCE_NOT_FOUND: 'ATTENDANCE_NOT_FOUND',
  BOOKING_NOT_ACTIVE: 'BOOKING_NOT_ACTIVE',
  ATTENDANCE_ALREADY_RECORDED: 'ATTENDANCE_ALREADY_RECORDED',
  DATE_NOT_ALLOWED: 'DATE_NOT_ALLOWED',
} as const;

export interface AttendanceActor {
  kind: ActorKindValue;
  userId: string;
  roles?: string[];
}

/**
 * Status-based attendance per booking and date (SRS 3.11, FRD FM-09). V1 has no GPS, face or payroll logic. The booking must
 * be ACTIVE for anything to be recorded; each date holds one record whose changes are kept as history; a worker records only
 * their own booking and only today, a customer may raise an exception for a date, staff may record and correct (with reason).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly repository: AttendanceRepository,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
  ) {}

  // --- recording --------------------------------------------------------------------------------------------

  async workerRecord(
    userId: string,
    workerId: string,
    bookingId: string,
    dto: RecordAttendanceDto,
  ): Promise<AttendanceView> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking || booking.workerId !== workerId) throw this.bookingNotFound();
    return this.record(
      booking,
      { date: indiaToday(), status: dto.status, note: dto.note },
      { kind: 'WORKER', userId },
    );
  }

  async customerRaiseException(
    userId: string,
    bookingId: string,
    dto: RaiseExceptionDto,
  ): Promise<AttendanceView> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking || booking.customerUserId !== userId) throw this.bookingNotFound();
    return this.record(
      booking,
      { date: dto.date, status: 'EXCEPTION', note: dto.note },
      { kind: 'CUSTOMER', userId },
    );
  }

  async adminRecord(
    bookingId: string,
    dto: AdminRecordAttendanceDto,
    admin: AttendanceActor,
  ): Promise<AttendanceView> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking) throw this.bookingNotFound();
    return this.record(booking, dto, admin);
  }

  /** Staff correction of an existing entry; the old value stays in the history with the reason. */
  async adminCorrect(
    attendanceId: string,
    dto: CorrectAttendanceDto,
    admin: AttendanceActor,
  ): Promise<AdminAttendanceView> {
    this.assertNote(dto.status, dto.note);
    await this.repository.transaction(async (tx) => {
      const record = await this.repository.lock(attendanceId, tx);
      if (!record) throw this.notFound();
      const note = dto.note ?? null;
      if (record.status === dto.status && record.note === note) return;
      await this.repository.update(record.id, { status: dto.status, note }, tx);
      await this.repository.addEvent(
        {
          recordId: record.id,
          fromStatus: record.status,
          toStatus: dto.status,
          note,
          reason: dto.reason,
          actorUserId: admin.userId,
          actorKind: 'ADMIN',
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'attendance.correct',
          entityType: 'attendance_record',
          entityId: record.id,
          actorId: admin.userId,
          actorRole: admin.roles?.join(',') || null,
          metadata: {
            bookingId: record.bookingId,
            date: record.date,
            from: record.status,
            to: dto.status,
          },
        },
        tx,
      );
    });
    const record = (await this.repository.findById(attendanceId))!;
    return this.adminView(record, await this.repository.listEvents([record.id]));
  }

  // --- reading ----------------------------------------------------------------------------------------------

  async listForWorker(
    workerId: string,
    bookingId: string,
    query: AttendanceListQuery,
  ): Promise<Page<AttendanceView>> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking || booking.workerId !== workerId) throw this.bookingNotFound();
    return this.page(bookingId, query);
  }

  async listForCustomer(
    userId: string,
    bookingId: string,
    query: AttendanceListQuery,
  ): Promise<Page<AttendanceView>> {
    const booking = await this.bookings.getSummary(bookingId).catch(() => null);
    if (!booking || booking.customerUserId !== userId) throw this.bookingNotFound();
    return this.page(bookingId, query);
  }

  async adminList(
    bookingId: string,
    query: AttendanceListQuery,
  ): Promise<Page<AdminAttendanceView>> {
    await this.bookings.getSummary(bookingId).catch(() => {
      throw this.bookingNotFound();
    });
    this.assertRange(query);
    const { items, total } = await this.repository.list(
      bookingId,
      { from: query.from, to: query.to },
      skipFor(query),
      query.limit,
    );
    const events = await this.repository.listEvents(items.map((i) => i.id));
    return {
      data: items.map((i) =>
        this.adminView(
          i,
          events.filter((e) => e.recordId === i.id),
        ),
      ),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  // --- internals --------------------------------------------------------------------------------------------

  private async record(
    booking: { id: string; status: string; workerId: string | null; startDate: string | null },
    input: { date: string; status: AttendanceStatusValue; note?: string },
    actor: AttendanceActor,
  ): Promise<AttendanceView> {
    this.assertNote(input.status, input.note);
    if (booking.status !== 'ACTIVE' || !booking.workerId) {
      throw new DomainException(
        AttendanceErrorCode.BOOKING_NOT_ACTIVE,
        'Attendance can be recorded only while the service is active',
        HttpStatus.CONFLICT,
      );
    }
    this.assertDate(input.date, booking.startDate);
    const note = input.note ?? null;
    const existing = await this.repository.findForDay(booking.id, input.date);
    if (existing) return this.sameOrConflict(existing, input.status, note);
    try {
      const created = await this.repository.transaction(async (tx) => {
        const row = await this.repository.create(
          {
            bookingId: booking.id,
            workerId: booking.workerId!,
            date: input.date,
            status: input.status,
            note,
            recordedByUserId: actor.userId,
            recordedByKind: actor.kind,
          },
          tx,
        );
        await this.repository.addEvent(
          {
            recordId: row.id,
            fromStatus: null,
            toStatus: input.status,
            note,
            actorUserId: actor.userId,
            actorKind: actor.kind,
          },
          tx,
        );
        await this.audit.record(
          {
            action: 'attendance.record',
            entityType: 'attendance_record',
            entityId: row.id,
            actorId: actor.userId,
            actorRole: actor.roles?.join(',') || actor.kind,
            metadata: {
              bookingId: booking.id,
              date: input.date,
              status: input.status,
              by: actor.kind,
            },
          },
          tx,
        );
        return row;
      });
      return this.view(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two recordings of the same day raced: the loser sees what the winner wrote.
      const winner = await this.repository.findForDay(booking.id, input.date);
      if (!winner) throw error;
      return this.sameOrConflict(winner, input.status, note);
    }
  }

  private sameOrConflict(
    existing: AttendanceRecordRow,
    status: AttendanceStatusValue,
    note: string | null,
  ): AttendanceView {
    if (existing.status === status && existing.note === note) return this.view(existing);
    throw new DomainException(
      AttendanceErrorCode.ATTENDANCE_ALREADY_RECORDED,
      'Attendance for this date is already recorded; only staff can correct it',
      HttpStatus.CONFLICT,
    );
  }

  private assertNote(status: AttendanceStatusValue, note: string | undefined): void {
    if (status === 'EXCEPTION' && !note) {
      throw this.invalid('note', 'a note is required for an exception');
    }
  }

  private assertDate(date: string, startDate: string | null): void {
    if (!isRealDate(date)) throw this.invalid('date', 'date is not a real date');
    const today = indiaToday();
    if (date > today || (startDate !== null && date < startDate)) {
      throw new DomainException(
        AttendanceErrorCode.DATE_NOT_ALLOWED,
        'Attendance can be recorded from the start date up to today',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [{ field: 'date', messages: [`allowed: ${startDate ?? 'start date'} to ${today}`] }],
      );
    }
  }

  private assertRange(query: AttendanceListQuery): void {
    for (const [field, value] of [
      ['from', query.from],
      ['to', query.to],
    ] as const) {
      if (value !== undefined && !isRealDate(value))
        throw this.invalid(field, `${field} is not a real date`);
    }
    if (query.from && query.to && query.from > query.to)
      throw this.invalid('from', 'from must not be after to');
  }

  private async page(bookingId: string, query: AttendanceListQuery): Promise<Page<AttendanceView>> {
    this.assertRange(query);
    const { items, total } = await this.repository.list(
      bookingId,
      { from: query.from, to: query.to },
      skipFor(query),
      query.limit,
    );
    return {
      data: items.map((i) => this.view(i)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  private view(row: AttendanceRecordRow): AttendanceView {
    return {
      id: row.id,
      bookingId: row.bookingId,
      date: row.date,
      status: row.status,
      note: row.note,
      recordedBy: row.recordedByKind,
      updatedAt: row.updatedAt,
    };
  }

  private adminView(
    row: AttendanceRecordRow,
    events: Awaited<ReturnType<AttendanceRepository['listEvents']>> = [],
  ): AdminAttendanceView {
    return {
      ...this.view(row),
      workerId: row.workerId,
      recordedByUserId: row.recordedByUserId,
      history: events.map((e) => ({
        from: e.fromStatus,
        to: e.toStatus,
        note: e.note,
        reason: e.reason,
        actorUserId: e.actorUserId,
        actorKind: e.actorKind,
        at: e.createdAt,
      })),
    };
  }

  private bookingNotFound(): DomainException {
    return new DomainException(
      AttendanceErrorCode.BOOKING_NOT_FOUND,
      'Booking not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private notFound(): DomainException {
    return new DomainException(
      AttendanceErrorCode.ATTENDANCE_NOT_FOUND,
      'Attendance record not found',
      HttpStatus.NOT_FOUND,
    );
  }

  private invalid(field: string, message: string): DomainException {
    return new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [message] }],
    );
  }
}
