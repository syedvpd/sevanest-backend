import type { UserStatus, UserType } from '../../generated/prisma/client';

/** A user as other modules may see it. Never carries credentials. */
export interface UserRecord {
  id: string;
  type: UserType;
  status: UserStatus;
  mobile: string | null;
  email: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Only for credential verification inside Auth. Never serialise this. */
export interface UserCredentialRecord extends UserRecord {
  passwordHash: string | null;
}

export interface RoleAndPermissions {
  roles: string[];
  permissions: string[];
}

/** Who is performing an administrative action (for audit). `userId` is null for system bootstrap. */
export interface Actor {
  userId: string | null;
  roles: string[];
}

export interface UserStatusChangedEvent {
  userId: string;
  from: UserStatus;
  to: UserStatus;
  actorId: string | null;
}
