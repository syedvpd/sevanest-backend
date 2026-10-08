import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { AppConfigService } from './config/app-config.service';

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
}

// Fail fast and loudly: with buffered logs a rejected bootstrap would otherwise leave a silent, half-started process.
bootstrap().catch((error: unknown) => {
  console.error('Fatal: API failed to start', error);
  process.exit(1);
});
