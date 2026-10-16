import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './common/audit/audit.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { RetentionRegistryModule } from './common/retention/retention.registry';
import { RetentionModule } from './modules/retention/retention.module';
import { RetentionWorkerModule } from './modules/retention/retention.worker';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { CacheModule } from './infrastructure/cache/cache.module';
import { RedisService } from './infrastructure/cache/redis.service';
import { RedisThrottlerStorage } from './infrastructure/cache/redis-throttler.storage';
import { DatabaseModule } from './infrastructure/database/database.module';
import { HealthModule } from './infrastructure/observability/health/health.module';
import { ObservabilityLoggerModule } from './infrastructure/observability/logger.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { LegalModule } from './modules/legal/legal.module';
import { AuthModule } from './modules/auth/auth.module';
import { SystemModule } from './modules/system/system.module';
import { MetaModule } from './modules/meta/meta.module';
import { SafetyModule } from './modules/safety/safety.module';
import { HomeModule } from './modules/home/home.module';
import { HistoryModule } from './modules/history/history.module';
import { ShortlistModule } from './modules/shortlist/shortlist.module';
import { WorkerPhotoModule } from './modules/worker-photo/worker-photo.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { BookingModule } from './modules/booking/booking.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { EarningsModule } from './modules/earnings/earnings.module';
import { ReplacementModule } from './modules/replacement/replacement.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { SupportModule } from './modules/support/support.module';
import { ReportsModule } from './modules/reports/reports.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PaymentModule } from './modules/payment/payment.module';
import { BookingWorkerModule } from './modules/booking/booking.worker';
import { PaymentWorkerModule } from './modules/payment/payment.worker';
import { SupportWorkerModule } from './modules/support/support.worker';
import { NotificationsWorkerModule } from './modules/notifications/notifications.worker';
import { VerificationWorkerModule } from './modules/verification/verification.worker';
import { MatchingModule } from './modules/matching/matching.module';
import { SearchModule } from './modules/search/search.module';
import { VerificationModule } from './modules/verification/verification.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { CustomersModule } from './modules/customers/customers.module';
import { CustomerPhotoModule } from './modules/customer-photo/customer-photo.module';
import { CustomerPhotoWorkerModule } from './modules/customer-photo/customer-photo.worker';
import { ServiceCategoriesModule } from './modules/service-categories/service-categories.module';
import { UsersModule } from './modules/users/users.module';
import { WorkersModule } from './modules/workers/workers.module';

/**
 * EMBEDDED_WORKERS=true runs the background loops (notification delivery, payment recovery, re-check reminders) INSIDE the API
 * process, for hosts where a separate worker service is not available or not paid for (e.g. a single Render web service). It is
 * safe with several replicas (all loops claim their rows atomically in PostgreSQL) but couples API load to background work; the
 * default is false because the intended deployment is a separate worker process (`node dist/worker`).
 */
const embeddedWorkers =
  process.env.EMBEDDED_WORKERS === 'true'
    ? [
        NotificationsWorkerModule,
        VerificationWorkerModule,
        PaymentWorkerModule,
        BookingWorkerModule,
        SupportWorkerModule,
        CustomerPhotoWorkerModule,
        RetentionWorkerModule,
      ]
    : [];

@Module({
  imports: [
    AppConfigModule,
    ObservabilityLoggerModule,
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService, RedisService],
      useFactory: (config: AppConfigService, redis: RedisService) => ({
        throttlers: [{ ttl: config.throttle.ttlMs, limit: config.throttle.limit }],
        ...(config.throttle.storage === 'redis'
          ? { storage: new RedisThrottlerStorage(redis) }
          : {}),
      }),
    }),
    DatabaseModule,
    CacheModule,
    QueueModule,
    AuditModule,
    OutboxModule,
    RetentionRegistryModule,
    IdempotencyModule,
    UsersModule,
    AlertsModule,
    LegalModule,
    AuthModule,
    WorkerPhotoModule,
    CustomerPhotoModule,
    ShortlistModule,
    HomeModule,
    HistoryModule,
    SafetyModule,
    MetaModule,
    SystemModule,
    CustomersModule,
    ServiceCategoriesModule,
    WorkersModule,
    AvailabilityModule,
    VerificationModule,
    SearchModule,
    MatchingModule,
    BookingModule,
    PaymentModule,
    NotificationsModule,
    AttendanceModule,
    EarningsModule,
    RetentionModule,
    ReplacementModule,
    RatingsModule,
    SupportModule,
    ReportsModule,
    HealthModule,
    ...embeddedWorkers,
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
