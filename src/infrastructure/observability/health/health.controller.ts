import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpException,
  Injectable,
  UseFilters,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../../common/decorators/auth.decorators';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../cache/redis.service';

const DEPENDENCY_TIMEOUT_MS = 2000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Readiness failures keep Terminus' own body (which dependency is down) instead of the generic error envelope. */
@Catch(HttpException)
class ReadinessFailureFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(exception.getStatus())
      .json(exception.getResponse());
  }
}

@Injectable()
export class DependencyHealth {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async database() {
    const indicator = this.indicators.check('database');
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, DEPENDENCY_TIMEOUT_MS);
      return indicator.up();
    } catch {
      return indicator.down({ message: 'unreachable' });
    }
  }

  async redisCheck() {
    const indicator = this.indicators.check('redis');
    try {
      await withTimeout(this.redis.ping(), DEPENDENCY_TIMEOUT_MS);
      return indicator.up();
    } catch {
      return indicator.down({ message: 'unreachable' });
    }
  }
}

/** Operational endpoints: unauthenticated, unthrottled, outside /api. Liveness never touches dependencies. */
@ApiTags('health')
@Public()
@SkipThrottle()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly dependencies: DependencyHealth,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe: the process is running' })
  @ApiOkResponse({ description: 'Process is alive' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @UseFilters(ReadinessFailureFilter)
  @ApiOperation({ summary: 'Readiness probe: PostgreSQL and Redis are reachable' })
  @ApiOkResponse({ description: 'All dependencies reachable' })
  @ApiServiceUnavailableResponse({ description: 'A dependency is unreachable' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.dependencies.database(),
      () => this.dependencies.redisCheck(),
    ]);
  }
}
