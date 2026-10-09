import { verifiedWorkerCondition } from './verification-eligibility';
import { effectiveStatus, indiaToday } from './verification.service';

describe('effectiveStatus', () => {
  const today = '2026-10-10';

  it('treats a missing check as NOT_SUBMITTED', () => {
    expect(effectiveStatus(undefined, today)).toBe('NOT_SUBMITTED');
  });

  it('keeps stored statuses as they are', () => {
    for (const status of ['NOT_SUBMITTED', 'SUBMITTED', 'IN_REVIEW', 'REJECTED'] as const) {
      expect(effectiveStatus({ status, recheckAt: null }, today)).toBe(status);
    }
  });

  it('keeps an approval valid until its re-check date, and due on the date itself', () => {
    expect(effectiveStatus({ status: 'APPROVED', recheckAt: null }, today)).toBe('APPROVED');
    expect(effectiveStatus({ status: 'APPROVED', recheckAt: '2026-10-11' }, today)).toBe(
      'APPROVED',
    );
    expect(effectiveStatus({ status: 'APPROVED', recheckAt: '2026-10-10' }, today)).toBe(
      'RECHECK_DUE',
    );
    expect(effectiveStatus({ status: 'APPROVED', recheckAt: '2026-01-01' }, today)).toBe(
      'RECHECK_DUE',
    );
  });

  it('never turns a non-approval into RECHECK_DUE', () => {
    expect(effectiveStatus({ status: 'REJECTED', recheckAt: '2020-01-01' }, today)).toBe(
      'REJECTED',
    );
  });
});

describe('indiaToday', () => {
  it('uses the India calendar, which is ahead of UTC late in the UTC day', () => {
    expect(indiaToday(new Date('2026-10-09T20:00:00Z'))).toBe('2026-10-10');
    expect(indiaToday(new Date('2026-10-09T10:00:00Z'))).toBe('2026-10-09');
  });
});

describe('verifiedWorkerCondition', () => {
  it('only accepts a plain column reference', () => {
    expect(() => verifiedWorkerCondition('wp.id')).not.toThrow();
    for (const bad of ['wp.id; DROP TABLE users', 'wp.id OR 1=1', '', 'wp.id)--', '1']) {
      expect(() => verifiedWorkerCondition(bad)).toThrow();
    }
  });

  it('requires at least one requirement and every requirement to be approved and not due', () => {
    const sql = verifiedWorkerCondition('wp.id').sql;
    expect(sql).toContain('EXISTS (SELECT 1 FROM verification_requirements)');
    expect(sql).toContain("vc.status = 'APPROVED'");
    expect(sql).toContain('vc.recheck_at IS NULL OR vc.recheck_at >');
  });
});
