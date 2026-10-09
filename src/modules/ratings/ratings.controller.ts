import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminRatingListQuery,
  AdminRatingView,
  CreateRatingDto,
  ModerationDto,
  RatingListQuery,
  RatingSummaryView,
  RatingView,
  WorkerRatingView,
} from './dto/ratings.dto';
import { RatingsService } from './ratings.service';

/** A customer's own ratings (FR-RAT-001/002). Every lookup is scoped to the signed-in customer. */
@ApiTags('Ratings')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'ratings', version: '1' })
export class RatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Post()
  @ApiOperation({
    summary: 'Rate the worker of my completed booking (once per booking)',
    description:
      '404 for a booking that is not mine, 422 RATING_NOT_ELIGIBLE unless the booking is COMPLETED, 400 RATING_SCORE_OUT_OF_SCALE, 409 RATING_ALREADY_EXISTS. A rating cannot be edited or deleted by the customer (Q-60).',
  })
  create(
    @Body() dto: CreateRatingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingView> {
    return this.ratings.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'My ratings, newest first (paginated)' })
  list(
    @Query() query: RatingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<RatingView>> {
    return this.ratings.listMine(user.userId, query);
  }

  @Get('bookings/:bookingId')
  @ApiOperation({ summary: 'My rating for one of my bookings (404 when none or not mine)' })
  forBooking(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingView> {
    return this.ratings.getMineForBooking(user.userId, bookingId);
  }

  @Get(':ratingId')
  @ApiOperation({ summary: 'One of my ratings (404 for anyone else)' })
  get(
    @Param('ratingId', ParseUUIDPipe) ratingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingView> {
    return this.ratings.getMine(user.userId, ratingId);
  }
}

/** "Worker can see received ratings" (FRD FM-10 step 4, FR-RAT-004). Visible ratings only, no customer identity. */
@ApiTags('Ratings')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/ratings', version: '1' })
export class WorkerRatingsController {
  constructor(
    private readonly ratings: RatingsService,
    private readonly workers: WorkersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Ratings I received, newest first (paginated, hidden ones excluded)' })
  async list(
    @Query() query: RatingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerRatingView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.ratings.listReceived(ref.workerId, query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'My rating count and average (FR-RAT-003)' })
  async summary(@CurrentUser() user: AuthenticatedUser): Promise<RatingSummaryView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.ratings.summaryFor(ref.workerId);
  }
}

/** Staff view and moderation of ratings. */
@ApiTags('Admin - Ratings')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/ratings', version: '1' })
export class AdminRatingsController {
  constructor(
    private readonly ratings: RatingsService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'All ratings (paginated, filter by status/worker/booking)' })
  list(@Query() query: AdminRatingListQuery): Promise<Page<AdminRatingView>> {
    return this.ratings.adminList(query);
  }

  @Get('workers/:workerId/summary')
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'A worker rating count and average' })
  summary(@Param('workerId', ParseUUIDPipe) workerId: string): Promise<RatingSummaryView> {
    return this.ratings.summaryFor(workerId);
  }

  @Get(':ratingId')
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'One rating with moderation details' })
  get(@Param('ratingId', ParseUUIDPipe) ratingId: string): Promise<AdminRatingView> {
    return this.ratings.adminGet(ratingId);
  }

  @Post(':ratingId/hide')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.RATING_MODERATE)
  @ApiOperation({
    summary: 'Hide a rating from the worker profile and totals (reason required, audited)',
  })
  async hide(
    @Param('ratingId', ParseUUIDPipe) ratingId: string,
    @Body() dto: ModerationDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminRatingView> {
    return this.ratings.hide(ratingId, dto.reason, await this.actor(admin));
  }

  @Post(':ratingId/unhide')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.RATING_MODERATE)
  @ApiOperation({ summary: 'Restore a hidden rating (reason required, audited)' })
  async unhide(
    @Param('ratingId', ParseUUIDPipe) ratingId: string,
    @Body() dto: ModerationDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminRatingView> {
    return this.ratings.unhide(ratingId, dto.reason, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<{ userId: string; roles: string[] }> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
