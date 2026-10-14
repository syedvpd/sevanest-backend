import { evaluateRatingEligibility } from './rating-eligibility';

const off = { alreadyRated: false, allowEndedEarly: false };

describe('evaluateRatingEligibility', () => {
  it('rates a completed booking with a worker, once', () => {
    const b = { status: 'COMPLETED', workerId: 'w', startDate: '2026-11-01' };
    expect(evaluateRatingEligibility(b, off)).toEqual({
      eligible: true,
      code: 'ELIGIBLE',
      reason: null,
    });
    expect(evaluateRatingEligibility(b, { ...off, alreadyRated: true }).code).toBe('ALREADY_RATED');
    expect(evaluateRatingEligibility({ ...b, workerId: null }, off).code).toBe('NO_WORKER');
  });

  it.each([
    'NEW_REQUEST',
    'MATCHED',
    'INTERVIEW_TRIAL_SCHEDULED',
    'INTERVIEW_TRIAL_COMPLETED',
    'PENDING_PAYMENT',
    'CONFIRMED',
    'ACTIVE',
    'REPLACEMENT_REQUESTED',
    'CANCELLED',
  ])('does not rate a %s booking', (status) => {
    const verdict = evaluateRatingEligibility(
      { status, workerId: 'w', startDate: null },
      { ...off, allowEndedEarly: true },
    );
    expect(verdict).toMatchObject({ eligible: false, code: 'NOT_COMPLETED' });
  });

  it('keeps an ended-early (REPLACED) booking unrateable until switched on, and then only if it started', () => {
    const replaced = { status: 'REPLACED', workerId: 'w', startDate: '2026-11-01' };
    expect(evaluateRatingEligibility(replaced, off)).toMatchObject({
      eligible: false,
      code: 'ENDED_EARLY_NOT_RATEABLE',
    });
    expect(evaluateRatingEligibility(replaced, { ...off, allowEndedEarly: true }).eligible).toBe(
      true,
    );
    expect(
      evaluateRatingEligibility({ ...replaced, startDate: null }, { ...off, allowEndedEarly: true })
        .eligible,
    ).toBe(false);
    expect(
      evaluateRatingEligibility(replaced, { alreadyRated: true, allowEndedEarly: true }).code,
    ).toBe('ALREADY_RATED');
  });
});
