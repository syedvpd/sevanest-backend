import { toCard } from './search.service';
import type { EligibleWorker } from './search.types';

describe('toCard', () => {
  it('copies an explicit allow-list, so extra worker fields can never reach a customer', () => {
    const worker = {
      id: 'w-1',
      userId: 'u-1',
      name: 'Private Name',
      experienceMonths: 12,
      engagementPreference: 'PART_TIME',
      categories: [{ code: 'COOK', name: 'Cook' }],
      languages: ['hi'],
      serviceAreas: [{ id: 'a-1', name: 'Area', city: 'City' }],
      availability: [{ startMinute: 540, endMinute: 1440 }],
      mobile: '+919999999999',
      expectedSalary: 1,
    } as EligibleWorker;
    const card = toCard(worker);
    expect(Object.keys(card).sort()).toEqual(
      [
        'availability',
        'categories',
        'engagementPreference',
        'experienceMonths',
        'initials',
        'languages',
        'name',
        'serviceAreas',
        'verification',
        'verified',
        'workerId',
      ].sort(),
    );
    expect(card.workerId).toBe('w-1');
    expect(card.availability).toEqual([{ start: '09:00', end: '24:00' }]);
    expect(JSON.stringify(card)).not.toMatch(/Private Name|u-1|919999|expectedSalary/);
  });

  it('shows only first name and last initial, and null when the profile has no name', () => {
    const base = {
      id: 'w-2',
      userId: 'u-2',
      experienceMonths: null,
      engagementPreference: null,
      categories: [],
      languages: [],
      serviceAreas: [],
      availability: [],
    };
    expect(toCard({ ...base, name: 'Lakshmi Devi Rao' })).toMatchObject({
      name: 'Lakshmi R.',
      initials: 'LR',
    });
    expect(toCard({ ...base, name: 'Madonna' })).toMatchObject({
      name: 'Madonna',
      initials: 'M',
    });
    expect(toCard({ ...base, name: '   ' })).toMatchObject({
      name: null,
      initials: null,
    });
  });
});
