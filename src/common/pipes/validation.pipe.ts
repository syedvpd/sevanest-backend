import { HttpStatus, ValidationError, ValidationPipe } from '@nestjs/common';
import { ApiErrorDetail, ErrorCode } from '../errors/error-codes';
import { DomainException } from '../errors/domain.exception';

function flatten(errors: ValidationError[], parent = ''): ApiErrorDetail[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    const own: ApiErrorDetail[] = error.constraints
      ? [{ field, messages: Object.values(error.constraints) }]
      : [];
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

/**
 * Global DTO validation (BEA p2): unknown fields are stripped, payloads are transformed to DTO types, and failures
 * become the standard VALIDATION_FAILED envelope with per-field messages. Submitted values are never echoed back.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidUnknownValues: true,
    validationError: { target: false, value: false },
    exceptionFactory: (errors: ValidationError[]) =>
      new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        flatten(errors),
      ),
  });
}
