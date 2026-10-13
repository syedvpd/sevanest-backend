import { DomainException } from '../errors/domain.exception';
import { assertIfMatch, etagOf, STALE_VERSION } from './if-match';

describe('If-Match', () => {
  const at = new Date('2026-10-12T09:30:00.123Z');

  it('allows a missing header and the wildcard', () => {
    expect(() => assertIfMatch(undefined, at)).not.toThrow();
    expect(() => assertIfMatch('*', at)).not.toThrow();
  });

  it('allows the current version, weak or in a list', () => {
    expect(() => assertIfMatch(etagOf(at), at)).not.toThrow();
    expect(() => assertIfMatch(`W/${etagOf(at)}`, at)).not.toThrow();
    expect(() => assertIfMatch(`"1", ${etagOf(at)}`, at)).not.toThrow();
  });

  it('refuses a stale or malformed version with 412 STALE_VERSION', () => {
    for (const header of ['"1"', 'garbage', '']) {
      try {
        assertIfMatch(header, at);
        throw new Error('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainException);
        expect((error as DomainException).code).toBe(STALE_VERSION);
        expect((error as DomainException).getStatus()).toBe(412);
      }
    }
  });
});
