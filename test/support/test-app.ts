import { Body, Controller, Get, HttpStatus, Post, Type as NestType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsInt, IsString, Min } from 'class-validator';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import {
  CurrentUser,
  Permissions,
  Public,
  Roles,
} from '../../src/common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../src/common/decorators/auth.decorators';
import { DomainException } from '../../src/common/errors/domain.exception';
import { AppConfigService } from '../../src/config/app-config.service';
import { RedisService } from '../../src/infrastructure/cache/redis.service';
import { PrismaService } from '../../src/infrastructure/database/prisma.service';
import { AuthRepository } from '../../src/modules/auth/auth.repository';
import { TokenService } from '../../src/modules/auth/token.service';

class EchoDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;
}

/** Routes that exist ONLY in tests, to exercise the global guards/pipes/filters without inventing business endpoints. */
@Controller({ path: 'test', version: '1' })
export class TestProbeController {
  @Get('protected')
  protectedByDefault(@CurrentUser() user: AuthenticatedUser): { userId: string } {
    return { userId: user.userId };
  }

  @Public()
  @Get('public')
  publicRoute(): { ok: true } {
    return { ok: true };
  }

  @Permissions('widget.read')
  @Get('needs-permission')
  needsPermission(): { ok: true } {
    return { ok: true };
  }

  @Roles('ops')
  @Get('needs-role')
  needsRole(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('echo')
  echo(@Body() dto: EchoDto): EchoDto {
    return dto;
  }

  @Public()
  @Get('boom')
  boom(): never {
    throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=hunter2');
  }

  @Public()
  @Get('domain')
  domain(): never {
    throw new DomainException('WIDGET_LOCKED', 'Widget is locked', HttpStatus.CONFLICT);
  }
}

export const TEST_USERS = {
  admin: { userId: 'user-admin', sessionId: 'session-active' },
  suspended: { userId: 'user-suspended', sessionId: 'session-suspended' },
  revoked: { userId: 'user-revoked', sessionId: 'session-revoked' },
  nobody: { userId: 'user-nobody', sessionId: 'session-nobody' },
} as const;

export interface TestInfra {
  prisma: { $queryRaw: jest.Mock };
  redis: { ping: jest.Mock };
}

export interface TestApp {
  app: NestExpressApplication;
  tokens: TokenService;
  infra: TestInfra;
  bearer(user: { userId: string; sessionId: string }): Promise<string>;
}

/**
 * Boots the real AppModule + real configureApp(), with only PostgreSQL, Redis and auth lookups stubbed.
 * ConfigModule.forRoot() reads the environment when app.module is first imported, so every spec must import one of the
 * test/support/env-*.ts files BEFORE this module (see foundation.e2e-spec.ts).
 */
export async function createTestApp(): Promise<TestApp> {
  const infra: TestInfra = {
    prisma: { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) },
    redis: { ping: jest.fn().mockResolvedValue(undefined) },
  };
  const authRepository = {
    findActiveSession: jest.fn((sessionId: string) => {
      const byId: Record<string, { userId: string; userStatus: 'ACTIVE' | 'SUSPENDED' }> = {
        'session-active': { userId: 'user-admin', userStatus: 'ACTIVE' },
        'session-suspended': { userId: 'user-suspended', userStatus: 'SUSPENDED' },
      };
      const found = byId[sessionId];
      return Promise.resolve(found ? { sessionId, userType: 'ADMIN', ...found } : null);
    }),
    getRoleAndPermissionCodes: jest.fn((userId: string) =>
      Promise.resolve(
        userId === 'user-admin'
          ? { roles: ['ops'], permissions: ['widget.read'] }
          : { roles: [], permissions: [] },
      ),
    ),
  };

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [TestProbeController as NestType<unknown>],
  })
    .overrideProvider(PrismaService)
    .useValue(infra.prisma)
    .overrideProvider(RedisService)
    .useValue(infra.redis)
    .overrideProvider(AuthRepository)
    .useValue(authRepository)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({
    rawBody: true,
    logger: false,
  });
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const tokens = app.get(TokenService);
  return {
    app,
    tokens,
    infra,
    bearer: async (user) =>
      `Bearer ${await tokens.signAccessToken({ sub: user.userId, sid: user.sessionId })}`,
  };
}
