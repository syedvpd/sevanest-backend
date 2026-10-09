import { DomainException } from '../../../common/errors/domain.exception';
import { TIME_OF_DAY, normaliseTimeWindows, toMinutes, toText } from './time-windows';

describe('TIME_OF_DAY', () => {
  it.each(['00:00', '09:30', '23:59', '24:00'])('accepts %s', (value) => {
    expect(TIME_OF_DAY.test(value)).toBe(true);
  });
  it.each(['24:01', '25:00', '9:30', '09:60', '09:30:00', '0930', '', ' 09:30', 'ab:cd'])(
    'rejects %p',
    (value) => {
      expect(TIME_OF_DAY.test(value)).toBe(false);
    },
  );
});

describe('toMinutes / toText', () => {
  it('round-trips every minute of the day including the 24:00 end', () => {
    for (let minute = 0; minute <= 1440; minute += 7) {
      expect(toMinutes(toText(minute))).toBe(minute);
    }
    expect(toMinutes('24:00')).toBe(1440);
    expect(toText(1440)).toBe('24:00');
    expect(toText(0)).toBe('00:00');
  });
});

describe('normaliseTimeWindows', () => {
  const reason = (windows: Array<{ start: string; end: string }>): string | undefined => {
    try {
      normaliseTimeWindows(windows);
    } catch (error) {
      return (error as DomainException).details?.[0].messages[0];
    }
    return undefined;
  };

  it('returns minutes sorted by start', () => {
    expect(
      normaliseTimeWindows([
        { start: '14:00', end: '18:00' },
        { start: '06:00', end: '10:00' },
      ]),
    ).toEqual([
      { startMinute: 360, endMinute: 600 },
      { startMinute: 840, endMinute: 1080 },
    ]);
  });

  it('allows windows that only touch, and a window ending at midnight', () => {
    expect(() =>
      normaliseTimeWindows([
        { start: '09:00', end: '12:00' },
        { start: '12:00', end: '24:00' },
      ]),
    ).not.toThrow();
  });

  it.each([
    ['start equals end', [{ start: '09:00', end: '09:00' }], 'must start before it ends'],
    ['start after end', [{ start: '18:00', end: '09:00' }], 'must start before it ends'],
    [
      'overnight (crosses midnight)',
      [{ start: '22:00', end: '02:00' }],
      'must start before it ends',
    ],
    ['start at 24:00', [{ start: '24:00', end: '24:00' }], 'must start before it ends'],
    [
      'overlap',
      [
        { start: '09:00', end: '13:00' },
        { start: '12:59', end: '15:00' },
      ],
      'must not overlap or repeat',
    ],
    [
      'contained window',
      [
        { start: '08:00', end: '18:00' },
        { start: '10:00', end: '12:00' },
      ],
      'must not overlap or repeat',
    ],
    [
      'exact duplicate',
      [
        { start: '09:00', end: '12:00' },
        { start: '09:00', end: '12:00' },
      ],
      'must not overlap or repeat',
    ],
  ])('rejects %s', (_name, windows, expected) => {
    expect(reason(windows)).toContain(expected);
  });
});
