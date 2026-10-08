import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './common/audit/audit.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { CacheModule } from './infrastructure/cache/cache.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HealthModule } from './infrastructure/observability/health/health.module';
import { ObservabilityLoggerModule } from './infrastructure/observability/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';

@Module({
  imports: [
    AppConfigModule,
    ObservabilityLoggerModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => [
        { ttl: config.throttle.ttlMs, limit: config.throttle.limit },
      ],
    }),
    DatabaseModule,
    CacheModule,
    QueueModule,
    AuditModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useFactory: () => new AllExceptionsFilter() },
    // Guard order matters: cheap abuse rejection first, then authentication, then role, then permission.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
