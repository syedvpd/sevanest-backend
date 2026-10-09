import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../../../common/errors/domain.exception';
import { ErrorCode } from '../../../common/errors/error-codes';

/** "HH:mm" on a 24-hour clock; "24:00" is allowed only as an END (the window runs to midnight). */
export const TIME_OF_DAY = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

export const MINUTES_PER_DAY = 24 * 60;

export interface TimeWindowText {
  start: string;
  end: string;
}

export interface TimeWindowMinutes {
  startMinute: number;
  endMinute: number;
}

export function toMinutes(text: string): number {
  const [hours, minutes] = text.split(':').map(Number);
  return hours * 60 + minutes;
}

export function toText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function invalid(message: string): DomainException {
  return new DomainException(
    ErrorCode.VALIDATION_FAILED,
    'Request validation failed',
    HttpStatus.BAD_REQUEST,
    [{ field: 'timeWindows', messages: [message] }],
  );
}

/**
 * Validates a worker's available timings (FRD FM-04 "Valid ranges") and returns them sorted by start.
 * Rules: each window starts before it ends and stays within one day ([start, end), local time, one timezone);
 * windows for one worker must not overlap or repeat; windows that merely touch (09:00-12:00 and 12:00-14:00) are allowed.
 * The database enforces the same rules with CHECK and exclusion constraints as a backstop.
 */
export function normaliseTimeWindows(windows: TimeWindowText[]): TimeWindowMinutes[] {
  const parsed = windows.map((window, index) => {
    const startMinute = toMinutes(window.start);
    const endMinute = toMinutes(window.end);
    if (startMinute >= endMinute) {
      throw invalid(`timeWindows[${index}] must start before it ends`);
    }
    return { startMinute, endMinute };
  });
  parsed.sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].startMinute < parsed[i - 1].endMinute) {
      throw invalid('timeWindows must not overlap or repeat');
    }
  }
  return parsed;
}
