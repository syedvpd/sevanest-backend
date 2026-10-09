import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';

/** A language code such as `en`, `hi` or `en-IN`. The specs list no catalogue, so this is a format rule only. */
export const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/**
 * FRD FM-02/FM-04: languages come "from supported languages", which the specs do not list. When an allow-list is
 * configured (SUPPORTED_LANGUAGES) it is enforced; when none is configured any well-formed code is accepted.
 */
export function assertLanguageSupported(
  language: string,
  allowList: string[],
  field = 'preferredLanguage',
): void {
  if (allowList.length > 0 && !allowList.includes(language)) {
    throw new DomainException(
      ErrorCode.VALIDATION_FAILED,
      'Request validation failed',
      HttpStatus.BAD_REQUEST,
      [{ field, messages: [`${field} contains an unsupported language`] }],
    );
  }
}
