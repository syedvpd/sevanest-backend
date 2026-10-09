import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.module';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { DatabaseModule } from './infrastructure/database/database.module';
import { CategorySeedService } from './modules/service-categories/category-seed.service';
import { ServiceCategoriesModule } from './modules/service-categories/service-categories.module';
import { RbacSeedService } from './modules/users/rbac-seed.service';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [AppConfigModule, DatabaseModule, AuditModule, UsersModule, ServiceCategoriesModule],
})
class SeedModule {}

/**
 * `npm run seed` (after `npm run build`). Idempotent reference data: roles, permissions, Super Admin mapping.
 * Optional development bootstrap: set BOOTSTRAP_SUPER_ADMIN_EMAIL and BOOTSTRAP_SUPER_ADMIN_PASSWORD in the environment
 * to create the first Super Admin. It is refused in production because production admin provisioning is an open
 * operational decision. Credentials come only from the environment and are never printed.
 */
async function seed(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn'] });
  try {
    const config = app.get(AppConfigService);
    const rbac = app.get(RbacSeedService);

    const summary = await rbac.ensureReferenceData();
    console.log(
      `RBAC reference data ensured: ${summary.roles} roles, ${summary.permissions} permissions, ${summary.superAdminPermissions} mapped to SUPER_ADMIN`,
    );

    const createdCategories = await app.get(CategorySeedService).ensureInitialCategories();
    console.log(
      `Service categories ensured: ${createdCategories} created (existing rows untouched)`,
    );

    const email = process.env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_SUPER_ADMIN_PASSWORD;
    if (!email && !password) {
      return;
    }
    if (!email || !password) {
      throw new Error(
        'Set both BOOTSTRAP_SUPER_ADMIN_EMAIL and BOOTSTRAP_SUPER_ADMIN_PASSWORD, or neither',
      );
    }
    if (config.isProduction) {
      throw new Error(
        'Super Admin bootstrap is disabled in production (provisioning is an open decision)',
      );
    }
    const created = await rbac.bootstrapSuperAdmin(email, password);
    console.log(
      created ? 'Bootstrap Super Admin created' : 'A Super Admin already exists; nothing created',
    );
  } finally {
    await app.close();
  }
}

seed().catch((error: unknown) => {
  console.error('Seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
