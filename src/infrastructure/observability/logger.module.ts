import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigService } from '../../config/app-config.service';
import { NodeEnv } from '../../config/env.validation';
import { ensureRequestId } from '../../common/request-context/request-context';

/** Paths that must never reach logs, even if some code logs a whole object. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.otp',
  '*.accessToken',
  '*.refreshToken',
  '*.refreshTokenHash',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.isTest ? 'silent' : config.logLevel,
          genReqId: (req, res) => ensureRequestId(req as never, res as never),
          redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
          // Minimal serializers: path without query string (queries can carry mobile numbers/PII), no headers, no bodies.
          serializers: {
            req: (req: { id?: unknown; method?: string; url?: string }) => ({
              id: req.id,
              method: req.method,
              path: req.url?.split('?')[0],
            }),
            res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
          },
          autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
          transport:
            config.nodeEnv === NodeEnv.Development
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
  ],
  exports: [LoggerModule],
})
export class ObservabilityLoggerModule {}
