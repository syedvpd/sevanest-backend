import { Module } from '@nestjs/common';
import { PasswordHasher } from '../../common/security/password-hasher.service';
import { RbacSeedService } from './rbac-seed.service';
import { UserEvents } from './user-events';
import { AdminAccessService } from './admin-access.service';
import { AdminRolesController, AdminUsersController, UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

/**
 * Users: the common identity/account domain (users, account status, role assignment). Customer- and
 * worker-specific data lives in their own modules. Sessions and credentials-in-use belong to Auth, which
 * depends on this module (never the reverse; account changes reach Auth through UserEvents).
 */
@Module({
  controllers: [UsersController, AdminUsersController, AdminRolesController],
  providers: [
    UsersRepository,
    UsersService,
    AdminAccessService,
    UserEvents,
    PasswordHasher,
    RbacSeedService,
  ],
  exports: [UsersService, UserEvents, PasswordHasher, RbacSeedService],
})
export class UsersModule {}
