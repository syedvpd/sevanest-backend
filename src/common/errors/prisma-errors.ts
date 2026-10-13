import { Prisma } from '../../generated/prisma/client';

/** True when a Prisma call failed because a UNIQUE constraint was violated (PostgreSQL 23505 / Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** True when a Prisma call failed because a FOREIGN KEY constraint was violated (PostgreSQL 23503 / Prisma P2003). */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
