import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { AppConfigService } from '../../config/app-config.service';
import { recordQuery } from '../../common/request-context/request-context';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Single Prisma client for the process (PostgreSQL is the source of truth). Only repositories should inject this;
 * controllers and services go through their module's repository.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);
  private healthPool?: Pool;
  private readonly healthUrl: string;

  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        query_timeout: config.databaseQueryTimeoutMs,
      }),
      ...(config.requestTimingLog
        ? { log: [{ emit: 'event' as const, level: 'query' as const }] }
        : {}),
    });
    this.healthUrl = config.databaseUrl;
    if (config.requestTimingLog) {
      // Only the duration is read: the statement text and its parameters are deliberately never touched.
      (this as unknown as { $on(event: 'query', cb: (e: { duration: number }) => void): void }).$on(
        'query',
        (e) => recordQuery(e.duration),
      );
    }
  }

  async onModuleInit(): Promise<void> {
    // Fail fast at boot if the database is unreachable; runtime outages surface through /health/ready.
    await this.$connect();
    this.logger.log('PostgreSQL connection established');
  }

  /**
   * Readiness check on its own single connection, never on the shared pool: when traffic has used every pooled connection the
   * probe would otherwise queue behind it, time out and report a busy instance as down (F-012). A dead database still fails it.
   */
  async ping(timeoutMs = 2000): Promise<void> {
    if (!this.healthPool) {
      this.healthPool = new Pool({
        connectionString: this.healthUrl,
        max: 1,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
      });
      // An idle probe connection dropped by the server must not crash the process; the next ping reconnects.
      this.healthPool.on('error', () => undefined);
    }
    await this.healthPool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.healthPool?.end().catch(() => undefined);
    await this.$disconnect();
  }
}
