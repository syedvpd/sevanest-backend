import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  UseInterceptors,
  applyDecorators,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { Observable, catchError, from, mergeMap, of, throwError } from 'rxjs';
import { DomainException } from '../errors/domain.exception';
import {
  IDEMPOTENCY_KEY_FORMAT,
  IdempotencyErrorCode,
  IdempotencyService,
} from './idempotency.service';

/**
 * `Idempotency-Key` for the endpoint it decorates. The header is optional (without it the request behaves as before); with it, repeats
 * of the same request return the first response (header `Idempotent-Replay: true`) and are never executed twice. Scoped per signed-in user.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { userId?: string } }>();
    const res = http.getResponse<Response>();
    const raw = req.headers['idempotency-key'];
    const userId = req.user?.userId;
    if (raw === undefined || !userId) return next.handle();
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!IDEMPOTENCY_KEY_FORMAT.test(key)) throw IdempotencyService.invalidKey();

    const path = req.originalUrl.split('?')[0];
    const hash = createHash('sha256')
      .update(JSON.stringify([req.method, path, req.body ?? null]))
      .digest('hex');
    return from(this.store.claim(userId, key, { method: req.method, path, hash })).pipe(
      mergeMap((claim): Observable<unknown> => {
        switch (claim.kind) {
          case 'REPLAY':
            res.status(claim.statusCode);
            res.setHeader('Idempotent-Replay', 'true');
            return of(claim.body);
          case 'REUSED':
            return throwError(
              () =>
                new DomainException(
                  IdempotencyErrorCode.IDEMPOTENCY_KEY_REUSED,
                  'This Idempotency-Key was already used for a different request',
                  HttpStatus.UNPROCESSABLE_ENTITY,
                ),
            );
          case 'IN_PROGRESS':
            return throwError(
              () =>
                new DomainException(
                  IdempotencyErrorCode.IDEMPOTENCY_IN_PROGRESS,
                  'A request with this Idempotency-Key is still being processed',
                  HttpStatus.CONFLICT,
                ),
            );
          case 'CLAIMED':
            return next.handle().pipe(
              mergeMap((body: unknown) =>
                from(
                  this.store.complete(
                    claim.id,
                    res.statusCode,
                    JSON.parse(JSON.stringify(body ?? null)) as unknown,
                  ),
                ).pipe(mergeMap(() => of(body))),
              ),
              catchError((error: unknown) =>
                from(this.store.release(claim.id).catch(() => undefined)).pipe(
                  mergeMap(() => throwError(() => error)),
                ),
              ),
            );
        }
      }),
    );
  }
}

/** Marks an unsafe endpoint as accepting `Idempotency-Key` (see IdempotencyInterceptor). */
export function Idempotent(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'Optional, 8-100 characters. Repeating the same request with the same key returns the first response instead of acting again; the same key with a different request is 422 IDEMPOTENCY_KEY_REUSED; a repeat while the first is still running is 409 IDEMPOTENCY_IN_PROGRESS. Keys last 24 hours.',
    }),
  );
}
