import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/**
 * Reports: read-only operational reporting (PRD section 14). Owns no table and imports only Users (to resolve the caller's permissions for the dashboard): it reads with
 * parameterised SELECTs inside READ ONLY transactions (see ReportsRepository) and embeds Verification's SQL definition of
 * "verified". Nothing depends on this module.
 */
@Module({
  imports: [UsersModule],
  controllers: [ReportsController, DashboardController],
  providers: [ReportsRepository, ReportsService, DashboardService],
})
export class ReportsModule {}
