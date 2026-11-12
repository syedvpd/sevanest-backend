import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost, LoggerService } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
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
  const headers = { removeHeader: jest.fn(), setHeader: jest.fn() };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ id: 'req-id-0001' }),
      getResponse: () => ({ headersSent: false, status, ...headers }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter(logger).catch(exception, host);
  return { status, headers, body: json.mock.calls[0]?.[0] as Record<string, unknown>, logger };
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

  it('never lets an error inherit handler headers (CSV attachment, public cache lifetime)', () => {
    const { headers } = run(new NotFoundException());
    expect(headers.removeHeader).toHaveBeenCalledWith('Content-Disposition');
    expect(headers.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/json; charset=utf-8',
    );
    expect(headers.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('logs a handled 503 (provider outage) as one warning, not as an error with a stack', () => {
    const { status, body, logger } = run(
      new DomainException(
        'SMS_DELIVERY_FAILED',
        'We could not send the OTP',
        HttpStatus.SERVICE_UNAVAILABLE,
      ),
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({ code: 'SMS_DELIVERY_FAILED' });
    expect(logger.error).not.toHaveBeenCalled();
    expect((logger as unknown as { warn: jest.Mock }).warn).toHaveBeenCalledTimes(1);
    expect((logger as unknown as { warn: jest.Mock }).warn.mock.calls[0][0]).toMatchObject({
      code: 'SMS_DELIVERY_FAILED',
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

  describe('database outage (F-004)', () => {
    const prismaError = (code: string, meta?: Record<string, unknown>) => ({
      name: 'PrismaClientKnownRequestError',
      code,
      meta,
      message: 'password authentication failed for user "sevanest" at 10.0.0.5',
    });

    it.each([
      ['unreachable server (raw query, no pg code)', prismaError('P2010', { code: 'N/A' })],
      ['bad credentials (raw query, 28P01)', prismaError('P2010', { code: '28P01' })],
      ['too many connections (raw query, 53300)', prismaError('P2010', { code: '53300' })],
      ['cannot connect now (raw query, 57P03)', prismaError('P2010', { code: '57P03' })],
      ['cannot reach database', prismaError('P1001')],
      ['pool timeout', prismaError('P2024')],
      [
        'model query on a dead server (errno code)',
        prismaError('ECONNREFUSED', { modelName: 'User' }),
      ],
      [
        'transaction on a dead server (AggregateError)',
        Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
      ],
      ['dropped connection', prismaError('ECONNRESET')],
      [
        'redis offline (no offline queue)',
        new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      ],
      ['redis connection closed', new Error('Connection is closed.')],
      ['driver read timeout', new Error('Query read timeout')],
      ['driver connect timeout', new Error('timeout exceeded when trying to connect')],
      ['init failure', { name: 'PrismaClientInitializationError' }],
    ])(
      'answers 503 SERVICE_UNAVAILABLE for %s, as a handled warning with no internals',
      (_n, e) => {
        const { status, body, logger } = run(e);
        expect(status).toHaveBeenCalledWith(503);
        expect(body).toEqual({
          code: ErrorCode.SERVICE_UNAVAILABLE,
          message: 'Service temporarily unavailable',
          requestId: 'req-id-0001',
        });
        expect(JSON.stringify(body)).not.toMatch(/sevanest|10\.0\.0\.5|password/);
        expect(logger.error).not.toHaveBeenCalled();
        expect((logger as unknown as { warn: jest.Mock }).warn).toHaveBeenCalledTimes(1);
      },
    );

    it('keeps a failing raw query (syntax error, constraint) a 500: that is a defect, not an outage', () => {
      const { status } = run(prismaError('P2010', { code: '42601' }));
      expect(status).toHaveBeenCalledWith(500);
    });
  });

  it('never includes a stack trace', () => {
    const { body } = run(new Error('boom'));
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  describe('429 Retry-After headers', () => {
    it('emits Retry-After from DomainException retryAfterSeconds details (clamped to >= 1)', () => {
      const locked = run(
        new DomainException('ADMIN_LOGIN_LOCKED', 'Locked', HttpStatus.TOO_MANY_REQUESTS, [
          { field: 'retryAfterSeconds', messages: ['840'] },
        ]),
      );
      expect(locked.status).toHaveBeenCalledWith(429);
      expect(locked.headers.setHeader).toHaveBeenCalledWith('Retry-After', '840');

      const clamped = run(
        new DomainException('OTP_COOLDOWN', 'Wait', HttpStatus.TOO_MANY_REQUESTS, [
          { field: 'retryAfterSeconds', messages: ['0'] },
        ]),
      );
      expect(clamped.headers.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    });

    it('preserves Retry-After header from ThrottlerGuard, normalizes suffixed headers, and falls back to 1', () => {
      const headerMap = new Map<string, string>([['retry-after-adminauth', '45']]);
      const setHeader = jest.fn((name: string, val: string) =>
        headerMap.set(name.toLowerCase(), val),
      );
      const removeHeader = jest.fn((name: string) => headerMap.delete(name.toLowerCase()));
      const json = jest.fn();
      const host = {
        switchToHttp: () => ({
          getRequest: () => ({ id: 'req-id-0002' }),
          getResponse: () => ({
            headersSent: false,
            status: jest.fn().mockReturnValue({ json }),
            setHeader,
            removeHeader,
            getHeader: (name: string) => headerMap.get(name.toLowerCase()),
            getHeaderNames: () => [...headerMap.keys()],
          }),
        }),
      } as unknown as ArgumentsHost;

      new AllExceptionsFilter({ error: jest.fn(), warn: jest.fn(), log: jest.fn() }).catch(
        new ThrottlerException(),
        host,
      );
      expect(removeHeader).toHaveBeenCalledWith('retry-after-adminauth');
      expect(setHeader).toHaveBeenCalledWith('Retry-After', '45');
      expect(json.mock.calls[0]?.[0]).toMatchObject({ code: ErrorCode.RATE_LIMITED });

      const fallback = run(new ThrottlerException());
      expect(fallback.status).toHaveBeenCalledWith(429);
      expect(fallback.headers.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    });
  });
});
