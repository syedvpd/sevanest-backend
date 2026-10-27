import { Prisma } from '../../generated/prisma/client';

/** Bookings that hold a worker's time: the customer has confirmed this worker (payment pending) or the service is running. Earlier stages (matched, interviews) hold nothing, so the first customer to confirm wins. */
export const HOLDING_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'ACTIVE',
  'REPLACEMENT_REQUESTED',
] as const;

/** Engagements that occupy ONE date; every other engagement repeats every day from its start date until it ends. */
export const SINGLE_DAY_ENGAGEMENTS = ['ONE_TIME', 'HOURLY', 'DAILY', 'SHIFT'] as const;

export interface BusyRequest {
  /** YYYY-MM-DD, India calendar. */
  startDate: string;
  /** Undefined is treated as a single day (the least aggressive reading; the booking itself is checked with its real engagement). */
  engagement?: string;
  /** A literal minute, or an SQL expression (e.g. a column of an unnest) to test many windows in one statement. */
  fromMinute: number | Prisma.Sql;
  toMinute: number | Prisma.Sql;
  /** A booking that must not count against itself. */
  excludeBookingId?: string;
  /** Minutes a worker needs between two jobs (travel). Each existing booking is widened by this on both sides. Default 0. */
  bufferMinutes?: number;
}

const isSingleDay = (engagement?: string): boolean =>
  engagement === undefined || (SINGLE_DAY_ENGAGEMENTS as readonly string[]).includes(engagement);

/**
 * "Is this worker already booked for that time?" as one SQL boolean expression, shared by search (hide busy workers), matching and
 * booking (refuse a double booking). A worker is busy when a holding booking of theirs overlaps BOTH in dates and in time of day:
 * a 1-hour cleaning on a date blocks only that hour of that date, so the worker can take another service the same day at another hour
 * and is free again as soon as the hour ends. A live-in engagement occupies the whole day. Recurring engagements (full-time,
 * part-time, live-in, monthly) occupy every day from their start date until they are completed or cancelled.
 */
export function workerBusyCondition(workerId: Prisma.Sql, r: BusyRequest): Prisma.Sql {
  const liveIn = r.engagement === 'LIVE_IN';
  const buffer = Math.max(0, Math.floor(r.bufferMinutes ?? 0));
  const from = liveIn ? 0 : r.fromMinute;
  const to = liveIn ? 1440 : r.toMinute;
  const endDate = isSingleDay(r.engagement) ? r.startDate : null;
  const exclude = r.excludeBookingId
    ? Prisma.sql`AND b.id <> ${r.excludeBookingId}::uuid`
    : Prisma.empty;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.worker_id = ${workerId}
      AND b.status::text IN (${Prisma.join([...HOLDING_STATUSES])})
      ${exclude}
      AND (CASE WHEN b.engagement::text = 'LIVE_IN' THEN 0 ELSE b.from_minute - ${buffer} END) < ${to}
      AND ${from} < (CASE WHEN b.engagement::text = 'LIVE_IN' THEN 1440 ELSE b.to_minute + ${buffer} END)
      AND COALESCE(b.start_date, b.requested_start_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          <= COALESCE(${endDate}::date, 'infinity'::date)
      AND ${r.startDate}::date <= (CASE WHEN b.engagement::text IN (${Prisma.join([...SINGLE_DAY_ENGAGEMENTS])})
          THEN COALESCE(b.start_date, b.requested_start_date, (b.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          ELSE 'infinity'::date END))`;
}
