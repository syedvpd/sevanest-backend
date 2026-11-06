import { SearchService } from './search.service';
import type { EligibleWorker } from './search.types';

const WORKER_ID = 'worker-1';
const CUSTOMER_ID = 'customer-1';

/**
 * Regression: same-day slots used to be filtered by "now + 60 minutes", so a customer could never book an interview that
 * started within the next hour. D-106 removed that notice period, so a same-day start now only has to be in the future.
 * The tests pin the clock so the result does not depend on when the suite runs.
 */
function serviceWith(
  availability: { startMinute: number; endMinute: number },
  taken: number[] = [],
): { service: SearchService; takenStarts: jest.Mock } {
  const worker = {
    id: WORKER_ID,
    userId: 'user-1',
    name: 'Aarti Menon',
    experienceMonths: 36,
    engagementPreference: 'FULL_TIME',
    categories: [],
    languages: [],
    serviceAreas: [],
    availability: [availability],
  } as unknown as EligibleWorker;

  const takenStarts = jest.fn().mockResolvedValue(new Set(taken));
  const repository = {
    findVisibleByIds: jest.fn().mockResolvedValue([worker]),
    ratingSummaries: jest.fn().mockResolvedValue(new Map()),
    takenStarts,
  };
  const service = new SearchService(
    repository as never,
    {} as never,
    {} as never,
    { linksFor: jest.fn().mockResolvedValue(new Map()) } as never,
    { search: { cacheTtlSeconds: 0 } } as never,
  );
  return { service, takenStarts };
}

/** 16:01 IST on 05 Nov 2026: a 09:20-21:20 window puts 16:20 nineteen minutes away. */
const NOW_16_01_IST = new Date('2026-11-05T10:31:00.000Z');

describe('SearchService.listSlots same-day lead time', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('offers a same-day start inside the next hour instead of dropping it', async () => {
    jest.useFakeTimers().setSystemTime(NOW_16_01_IST);
    const { service } = serviceWith({ startMinute: 560, endMinute: 1280 });

    const view = await service.listSlots(WORKER_ID, { date: '2026-11-05' }, CUSTOMER_ID);

    expect(view.slots[0]).toBe('16:20');
    expect(view.slots).toContain('17:20');
  });

  it('still hides same-day starts that are already in the past', async () => {
    jest.useFakeTimers().setSystemTime(NOW_16_01_IST);
    const { service } = serviceWith({ startMinute: 560, endMinute: 1280 });

    const view = await service.listSlots(WORKER_ID, { date: '2026-11-05' }, CUSTOMER_ID);

    expect(view.slots).not.toContain('15:20');
    expect(view.slots).not.toContain('16:00');
  });

  it('applies no lead time to any later date', async () => {
    jest.useFakeTimers().setSystemTime(NOW_16_01_IST);
    const { service } = serviceWith({ startMinute: 560, endMinute: 1280 });

    const view = await service.listSlots(WORKER_ID, { date: '2026-11-06' }, CUSTOMER_ID);

    expect(view.slots[0]).toBe('09:20');
    expect(view.slots).toContain('16:20');
  });

  it('still removes a start time that is already taken', async () => {
    jest.useFakeTimers().setSystemTime(NOW_16_01_IST);
    const { service, takenStarts } = serviceWith({ startMinute: 560, endMinute: 1280 }, [980]);

    const view = await service.listSlots(WORKER_ID, { date: '2026-11-05' }, CUSTOMER_ID);

    expect(takenStarts).toHaveBeenCalledWith(WORKER_ID, '2026-11-05', expect.any(Array), 60);
    expect(view.slots).not.toContain('16:20');
    expect(view.slots).toContain('17:20');
  });
});
