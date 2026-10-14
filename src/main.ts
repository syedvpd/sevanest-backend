import 'reflect-metadata';
import { initSentry } from './common/observability/sentry';

initSentry('api');
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';
import { ReadinessService } from './modules/system/readiness.service';

async function bootstrap(): Promise<void> {
  // rawBody is kept so webhook signatures (payment provider) can be verified against the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);
  configureApp(app, config);

  await app.listen(config.port, '0.0.0.0');
  new NestLogger('Bootstrap').log(`API listening on port ${config.port} (${config.nodeEnv})`);
  void logLaunchReadiness(app);
}

/** Missing launch setup is visible in the startup log, not only to an admin who opens /admin/system/readiness. */
async function logLaunchReadiness(app: NestExpressApplication): Promise<void> {
  const logger = new NestLogger('Readiness');
  try {
    const report = await app.get(ReadinessService).report();
    for (const check of report.checks.filter((c) => !c.ok && c.key !== 'background_workers')) {
      logger.warn(`${check.level} ${check.key}: ${check.message}`);
    }
    if (report.ready) logger.log('Launch readiness: no blocker');
  } catch (error) {
    logger.warn(`Launch readiness could not be computed: ${(error as Error).message}`);
  }
}

// Fail fast and loudly: with buffered logs a rejected bootstrap would otherwise leave a silent, half-started process.
bootstrap().catch((error: unknown) => {
  console.error('Fatal: API failed to start', error);
  process.exit(1);
});
