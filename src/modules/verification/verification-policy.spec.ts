import {
  addBusinessHours,
  maskDocumentNumber,
  slaOf,
  TERMINAL_REJECTION_CODES,
} from './verification-policy';

// IST = UTC+5:30. 2026-10-26 is a Monday.
const ist = (iso: string): Date => new Date(`${iso}+05:30`);

describe('addBusinessHours (09:00-19:00 IST, Monday to Saturday)', () => {
  it('counts inside one day', () => {
    expect(addBusinessHours(ist('2026-10-26T10:00:00'), 2).toISOString()).toBe(
      ist('2026-10-26T12:00:00').toISOString(),
    );
  });

  it('rolls into the next business day at closing time', () => {
    expect(addBusinessHours(ist('2026-10-26T17:00:00'), 4).toISOString()).toBe(
      ist('2026-10-27T11:00:00').toISOString(),
    );
  });

  it('starts an after-hours submission at 09:00 on the next business day', () => {
    expect(addBusinessHours(ist('2026-10-26T20:30:00'), 1).toISOString()).toBe(
      ist('2026-10-27T10:00:00').toISOString(),
    );
    expect(addBusinessHours(ist('2026-10-26T06:00:00'), 1).toISOString()).toBe(
      ist('2026-10-26T10:00:00').toISOString(),
    );
  });

  it('skips Sunday', () => {
    // Saturday 2026-10-31 18:00 + 2h: one hour Saturday, one hour on Monday 09:00-10:00.
    expect(addBusinessHours(ist('2026-10-31T18:00:00'), 2).toISOString()).toBe(
      ist('2026-11-02T10:00:00').toISOString(),
    );
    expect(addBusinessHours(ist('2026-11-01T12:00:00'), 1).toISOString()).toBe(
      ist('2026-11-02T10:00:00').toISOString(),
    );
  });

  it('gives 24 business hours as two days and four hours of 10-hour days', () => {
    expect(addBusinessHours(ist('2026-10-26T09:00:00'), 24).toISOString()).toBe(
      ist('2026-10-28T13:00:00').toISOString(),
    );
  });
});

describe('slaOf', () => {
  const submittedAt = ist('2026-10-26T09:00:00');

  it('flags OVERDUE after 24 business hours and not before', () => {
    const base = { status: 'SUBMITTED', submittedAt, claimedAt: null, reviewerUserId: null };
    expect(slaOf(base, ist('2026-10-28T12:59:00')).flags).toEqual([]);
    expect(slaOf(base, ist('2026-10-28T13:01:00')).flags).toEqual(['OVERDUE']);
  });

  it('flags STALLED_CLAIM when a claim is older than 2 hours', () => {
    const claimedAt = ist('2026-10-26T10:00:00');
    const base = { status: 'IN_REVIEW', submittedAt, claimedAt, reviewerUserId: 'u' };
    expect(slaOf(base, ist('2026-10-26T11:59:00')).flags).toEqual([]);
    expect(slaOf(base, ist('2026-10-26T12:01:00')).flags).toEqual(['STALLED_CLAIM']);
  });

  it('never flags a decided check', () => {
    const decided = { status: 'APPROVED', submittedAt, claimedAt: null, reviewerUserId: 'u' };
    expect(slaOf(decided, ist('2027-01-01T00:00:00')).flags).toEqual([]);
  });
});

describe('maskDocumentNumber', () => {
  it('keeps only the last four characters', () => {
    expect(maskDocumentNumber('1234 5678 9012')).toBe('XXXX-XXXX-9012');
    expect(maskDocumentNumber('dl-04 2011 0149646')).toBe('XXXX-XXXX-9646');
    expect(maskDocumentNumber('12')).toBeNull();
  });
});

describe('terminal rejection codes', () => {
  it('are the disqualifying ones only', () => {
    expect([...TERMINAL_REJECTION_CODES].sort()).toEqual([
      'CRIMINAL_RECORD_DISQUALIFIED',
      'SUSPECTED_TAMPERING',
    ]);
  });
});
