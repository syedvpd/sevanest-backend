import { runWithTestRequestId } from '../../../test/support/request-id';
import { AuditRepository } from './audit.repository';
import { AuditService, redactSensitive } from './audit.service';

describe('redactSensitive', () => {
  it('redacts secret-like keys at any depth, including camelCase forms', () => {
    const out = redactSensitive({
      note: 'ok',
      password: 'p',
      newPassword: 'p2',
      refreshToken: 't',
      nested: { otp: '123456', deeper: [{ apiKey: 'k', fine: 1 }] },
      aadhaarNumber: 'x',
      pan: 'ABCDE1234F',
    });
    expect(out).toEqual({
      note: 'ok',
      password: '[REDACTED]',
      newPassword: '[REDACTED]',
      refreshToken: '[REDACTED]',
      nested: { otp: '[REDACTED]', deeper: [{ apiKey: '[REDACTED]', fine: 1 }] },
      aadhaarNumber: '[REDACTED]',
      pan: '[REDACTED]',
    });
  });

  it('does not over-redact innocent keys that merely contain a sensitive substring', () => {
    expect(redactSensitive({ company: 'Acme', footprint: 1, span: 2, tokenizer: 'x' })).toEqual({
      company: 'Acme',
      footprint: 1,
      span: 2,
      tokenizer: 'x',
    });
  });

  it('truncates absurd depth and serialises dates', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactSensitive(deep))).toContain('[TRUNCATED]');
    expect(redactSensitive({ at: new Date('2026-01-01T00:00:00Z') })).toEqual({
      at: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('AuditService', () => {
  it('writes actor, role, action, entity, redacted metadata and the request id; forwards the transaction', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({ insert } as unknown as AuditRepository);
    const tx = { marker: 'tx' } as never;

    await runWithTestRequestId('req-audit-0001', () =>
      service.record(
        {
          action: 'worker.verify',
          entityType: 'Worker',
          entityId: 'w1',
          actorId: 'u1',
          actorRole: 'verification_executive',
          metadata: { remarks: 'ok', password: 'nope' },
        },
        tx,
      ),
    );

    expect(insert).toHaveBeenCalledWith(
      {
        action: 'worker.verify',
        entityType: 'Worker',
        entityId: 'w1',
        actorId: 'u1',
        actorRole: 'verification_executive',
        metadata: { remarks: 'ok', password: '[REDACTED]' },
        requestId: 'req-audit-0001',
      },
      tx,
    );
  });

  it('defaults optional fields to null/undefined outside a request', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    await new AuditService({ insert } as unknown as AuditRepository).record({
      action: 'a',
      entityType: 'T',
    });
    expect(insert).toHaveBeenCalledWith(
      {
        action: 'a',
        entityType: 'T',
        entityId: null,
        actorId: null,
        actorRole: null,
        metadata: undefined,
        requestId: null,
      },
      undefined,
    );
  });
});
