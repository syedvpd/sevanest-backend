import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Single Prisma client for the process (PostgreSQL is the source of truth). Only repositories should inject this;
 * controllers and services go through their module's repository.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.databaseUrl,
        max: config.databasePoolMax,
        query_timeout: config.databaseQueryTimeoutMs,
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    // Fail fast at boot if the database is unreachable; runtime outages surface through /health/ready.
    await this.$connect();
    this.logger.log('PostgreSQL connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
