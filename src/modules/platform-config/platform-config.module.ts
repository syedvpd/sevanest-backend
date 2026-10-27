import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminPlatformConfigController } from './platform-config.controller';
import { PlatformConfigRepository } from './platform-config.repository';
import { PlatformConfigService } from './platform-config.service';

/**
 * Platform configuration: the app start-up settings (GET /app-config) and the rating tag catalogue (GET /reference-data), stored in
 * the database and edited by staff. Owns `app_settings` and `rating_tags`. Meta and Ratings read it; it depends only on Users.
 */
@Module({
  imports: [UsersModule],
  controllers: [AdminPlatformConfigController],
  providers: [PlatformConfigRepository, PlatformConfigService],
  exports: [PlatformConfigService],
})
export class PlatformConfigModule {}
