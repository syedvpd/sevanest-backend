import { DomainException } from '../errors/domain.exception';
import { LANGUAGE_CODE, assertLanguageSupported } from './language';

describe('LANGUAGE_CODE', () => {
  it.each(['en', 'hi', 'te', 'en-IN', 'zh-Hant'])('accepts %s', (code) => {
    expect(LANGUAGE_CODE.test(code)).toBe(true);
  });
  it.each(['', 'English', 'EN', 'e', 'en_IN', 'en-', '12'])('rejects %p', (code) => {
    expect(LANGUAGE_CODE.test(code)).toBe(false);
  });
});

describe('assertLanguageSupported', () => {
  it('accepts any well-formed code when no allow-list is configured', () => {
    expect(() => assertLanguageSupported('te', [])).not.toThrow();
  });

  it('enforces the allow-list when one is configured and names the field', () => {
    expect(() => assertLanguageSupported('hi', ['en', 'hi'])).not.toThrow();
    let error: unknown;
    try {
      assertLanguageSupported('te', ['en', 'hi'], 'languages');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainException);
    expect((error as DomainException).details?.[0].field).toBe('languages');
  });
});
