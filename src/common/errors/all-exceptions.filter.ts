import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId } from '../request-context/request-context';
import { ApiErrorBody, ApiErrorDetail, ErrorCode, ErrorCodeValue } from './error-codes';

const STATUS_TO_CODE: Record<number, ErrorCodeValue> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.BAD_REQUEST,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.UNAUTHENTICATED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ErrorCode.PAYLOAD_TOO_LARGE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMITED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

const SAFE_MESSAGE_BY_STATUS: Record<number, string> = {
  [HttpStatus.UNAUTHORIZED]: 'Authentication is required',
  [HttpStatus.FORBIDDEN]: 'You do not have permission to perform this action',
  [HttpStatus.NOT_FOUND]: 'Resource not found',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests, please retry later',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'Request body is too large',
};

function genericMessage(status: number): string {
  return status >= 500 ? 'Service temporarily unavailable' : 'Invalid request';
}

interface Mapped {
  status: number;
  body: ApiErrorBody;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Converts every thrown error into the single API error envelope. Unknown errors are logged with their stack
 * server-side and returned as a generic 500: internals, SQL and stack traces never reach clients.
 */
/** Registered via useFactory (see AppModule); the logger is a plain constructor argument so tests can inject a fake. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService = new Logger(AllExceptionsFilter.name)) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const requestId = getRequestId() ?? (typeof request.id === 'string' ? request.id : undefined);

    const { status, body } = this.map(exception);
    body.requestId = requestId;

    if (status >= 500) {
      this.logger.error(
        {
          msg: 'Unhandled exception',
          requestId,
          err: exception instanceof Error ? exception : String(exception),
        },
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (response.headersSent) {
      return;
    }
    response.status(status).json(body);
  }

  private map(exception: unknown): Mapped {
    if (exception instanceof HttpException) {
      return this.mapHttpException(exception);
    }
    if (isRecord(exception)) {
      const prisma = this.mapPrismaError(exception);
      if (prisma) {
        return prisma;
      }
      // Express/body-parser errors (malformed JSON, oversized body) carry a client status.
      const status = exception['status'] ?? exception['statusCode'];
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return {
          status,
          body: {
            code: STATUS_TO_CODE[status] ?? ErrorCode.BAD_REQUEST,
            message: SAFE_MESSAGE_BY_STATUS[status] ?? 'Malformed request',
          },
        };
      }
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCode.INTERNAL_ERROR, message: 'An unexpected error occurred' },
    };
  }

  private mapHttpException(exception: HttpException): Mapped {
    const status = exception.getStatus();
    const response = exception.getResponse();
    // Messages are only trusted when they come from our own DomainException (it carries a `code`). Any other
    // HttpException (framework, body parser, third-party) gets a generic message so internals never leak.
    const ownCode =
      isRecord(response) && typeof response['code'] === 'string' ? response['code'] : undefined;
    const code: ErrorCodeValue = ownCode ?? STATUS_TO_CODE[status] ?? ErrorCode.BAD_REQUEST;
    let message = SAFE_MESSAGE_BY_STATUS[status] ?? genericMessage(status);
    let details: ApiErrorDetail[] | undefined;

    if (ownCode && isRecord(response)) {
      if (typeof response['message'] === 'string') {
        message = response['message'];
      }
      if (Array.isArray(response['details'])) {
        details = response['details'] as ApiErrorDetail[];
      }
    }
    return { status, body: { code, message, ...(details ? { details } : {}) } };
  }

  private mapPrismaError(error: Record<string, unknown>): Mapped | undefined {
    if (error['name'] !== 'PrismaClientKnownRequestError' || typeof error['code'] !== 'string') {
      return undefined;
    }
    switch (error['code']) {
      case 'P2002': // unique constraint
      case 'P2003': // foreign key constraint
        return {
          status: HttpStatus.CONFLICT,
          body: { code: ErrorCode.CONFLICT, message: 'The request conflicts with existing data' },
        };
      case 'P2025': // record required but not found
        return {
          status: HttpStatus.NOT_FOUND,
          body: {
            code: ErrorCode.NOT_FOUND,
            message: SAFE_MESSAGE_BY_STATUS[HttpStatus.NOT_FOUND],
          },
        };
      default:
        return undefined;
    }
  }
}
