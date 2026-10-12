import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './infrastructure/database/database.module';
import { PrismaService } from './infrastructure/database/prisma.service';
import { DEFAULT_IN_APP_TEMPLATES } from './modules/notifications/default-templates';
import { NotificationsRepository } from './modules/notifications/notifications.repository';

@Module({ imports: [AppConfigModule, DatabaseModule] })
class SeedLaunchModule {}

/** The Hyderabad pilot areas named in PRD section 22. City-wide expansion adds areas through the admin API, not here. */
const PILOT_CITY = 'Hyderabad';
const PILOT_AREAS = ['HITEC City', 'Madhapur', 'Kondapur', 'Gachibowli', 'Kukatpally'];

/**
 * `npm run seed:launch` (after `npm run build`): the starter data a fresh deployment needs before anything works, so the platform
 * does not silently do nothing:
 *  - the five pilot areas from PRD section 22 (service areas are what customers search and book in);
 *  - starter in-app wording for every notification event, only where no template exists yet (an administrator's wording is never
 *    overwritten). The wording is a neutral placeholder for the business to review.
 * Idempotent. It deliberately does NOT invent business values: the booking fee (Q-01), the required verification checks (Q-04),
 * support categories and any SMS/WhatsApp wording stay for an administrator to set. `GET /admin/system/readiness` lists what is
 * still missing.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SeedLaunchModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    let areas = 0;
    for (const name of PILOT_AREAS) {
      const existing = await prisma.serviceArea.findFirst({ where: { name, city: PILOT_CITY } });
      if (!existing) {
        await prisma.serviceArea.create({ data: { name, city: PILOT_CITY } });
        areas++;
      }
    }
    const repository = new NotificationsRepository(prisma);
    let templates = 0;
    for (const t of DEFAULT_IN_APP_TEMPLATES) {
      if (
        await repository.upsertDefaultTemplate({
          eventCode: t.event,
          channel: 'IN_APP',
          language: 'en',
          title: t.title,
          body: t.body,
        })
      ) {
        templates++;
      }
    }
    console.log(`Pilot areas created: ${areas} (existing untouched)`);
    console.log(`Starter in-app templates created: ${templates} (existing untouched)`);
    console.log(
      'Still for an administrator: booking fee, required verification checks, support categories, SMS/WhatsApp wording. See GET /admin/system/readiness.',
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Launch seed failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
