import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiErrorDetail, ErrorCodeValue } from './error-codes';

/**
 * Business-rule failure with a stable machine code. Modules throw this (or subclasses) instead of raw HttpExceptions,
 * e.g. an illegal state transition is a 409 (BEA p6).
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details?: ApiErrorDetail[],
  ) {
    super({ code, message, details }, status);
  }
}
