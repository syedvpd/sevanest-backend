import { Module } from '@nestjs/common';
import { MalwareModule } from '../../integrations/malware/malware.module';
import { StorageModule } from '../../integrations/storage/storage.module';
import { UsersModule } from '../users/users.module';
import { AdminProfileController } from './admin-profile.controller';
import { AdminProfileRepository } from './admin-profile.repository';
import { AdminProfileService } from './admin-profile.service';

/**
 * The signed-in admin's own profile and photo. Separate from the admin-user administration module: that one manages OTHER
 * accounts and is permission-gated; this one only ever touches the caller's own row.
 */
@Module({
  imports: [UsersModule, StorageModule, MalwareModule],
  controllers: [AdminProfileController],
  providers: [AdminProfileRepository, AdminProfileService],
  exports: [AdminProfileService],
})
export class AdminProfileModule {}
