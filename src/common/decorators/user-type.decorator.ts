import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { UserType } from '../../generated/prisma/client';
import { USER_TYPES_KEY, UserTypeGuard } from '../guards/user-type.guard';

/**
 * Restricts a controller/route to the given user types (CUSTOMER, WORKER, ADMIN). It runs after the global
 * authentication guard, which attaches the user type, so it needs no database access. Role/permission checks and
 * object-level ownership are separate and still required.
 */
export const RequireUserType = (...types: UserType[]): MethodDecorator & ClassDecorator =>
  applyDecorators(SetMetadata(USER_TYPES_KEY, types), UseGuards(UserTypeGuard));
