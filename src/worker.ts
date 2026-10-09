import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  // Until a module registers BullMQ workers nothing else holds the event loop open, and a worker that exits on its own would be restart-looped by the orchestrator. Stay alive until SIGTERM/SIGINT (handled by the shutdown hooks above).
  setInterval(() => undefined, 60_000);
  new NestLogger('Worker').log(
    'Worker process started (queue consumers register with their modules)',
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Fatal: worker failed to start', error);
  process.exit(1);
});
