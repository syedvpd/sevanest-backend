import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost, LoggerService } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { DomainException } from './domain.exception';
import { ErrorCode } from './error-codes';

function run(exception: unknown) {
  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  } as unknown as LoggerService & {
    error: jest.Mock;
  };
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-id-0001' }),
      getResponse: () => ({ headersSent: false, status }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(logger).catch(exception, host);
  return { status, body: json.mock.calls[0]?.[0] as Record<string, unknown>, logger };
}

describe('AllExceptionsFilter', () => {
  it('maps DomainException to its own code, message, status and details', () => {
    const { status, body } = run(
      new DomainException('BOOKING_STATE_INVALID', 'Illegal transition', HttpStatus.CONFLICT, [
        { field: 'status', messages: ['x'] },
      ]),
    );
    expect(status).toHaveBeenCalledWith(409);
    expect(body).toEqual({
      code: 'BOOKING_STATE_INVALID',
      message: 'Illegal transition',
      details: [{ field: 'status', messages: ['x'] }],
      requestId: 'req-id-0001',
    });
  });

  it('does not leak framework/parser messages from plain HttpExceptions', () => {
    const { body } = run(new BadRequestException('Unexpected token } in JSON at position 1'));
    expect(body).toMatchObject({ code: ErrorCode.BAD_REQUEST, message: 'Invalid request' });
    expect(JSON.stringify(body)).not.toContain('JSON');
  });

  it('maps standard statuses to stable codes', () => {
    expect(run(new NotFoundException('Cannot GET /x')).body).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Resource not found',
    });
  });

  it('turns unknown errors into a generic 500 and logs the real error server-side', () => {
    const { status, body, logger } = run(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(body).toEqual({
      code: ErrorCode.INTERNAL_ERROR,
      message: 'An unexpected error occurred',
      requestId: 'req-id-0001',
    });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('maps Prisma unique violations to 409 without exposing constraint details', () => {
    const { status, body } = run({
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: ['mobile'] },
    });
    expect(status).toHaveBeenCalledWith(409);
    expect(JSON.stringify(body)).not.toContain('mobile');
  });

  it('maps Prisma record-not-found to 404', () => {
    expect(
      run({ name: 'PrismaClientKnownRequestError', code: 'P2025' }).status,
    ).toHaveBeenCalledWith(404);
  });

  it('maps client-error status objects (e.g. body-parser) to 4xx, not 500', () => {
    const { status, body } = run({ status: 413, message: 'request entity too large' });
    expect(status).toHaveBeenCalledWith(413);
    expect(body).toMatchObject({ code: ErrorCode.PAYLOAD_TOO_LARGE });
  });

  it('never includes a stack trace', () => {
    const { body } = run(new Error('boom'));
    expect(JSON.stringify(body)).not.toContain('at ');
  });
});
