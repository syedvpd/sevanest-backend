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
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
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
  RatingEligibilityView,
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

  @Idempotent()
  @Post()
  @ApiModelResponse(RatingView, { status: 201 })
  @ApiOperation({
    summary: 'Rate the worker of my completed booking (once per booking)',
    description:
      '404 for a booking that is not mine, 422 RATING_NOT_ELIGIBLE unless GET /ratings/bookings/{id}/eligibility says eligible, 400 RATING_SCORE_OUT_OF_SCALE, 400 RATING_REVIEW_TOO_LONG (limit = ratingReviewMax in /reference-data), 409 RATING_ALREADY_EXISTS. A rating cannot be edited or deleted by the customer (Q-60).',
  })
  create(
    @Body() dto: CreateRatingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingView> {
    return this.ratings.create(user.userId, dto);
  }

  @Get()
  @ApiPageResponse(RatingView)
  @ApiOperation({ summary: 'My ratings, newest first (paginated)' })
  list(
    @Query() query: RatingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<RatingView>> {
    return this.ratings.listMine(user.userId, query);
  }

  @Get('bookings/:bookingId/eligibility')
  @ApiModelResponse(RatingEligibilityView)
  @ApiOperation({
    summary: 'May I rate this booking right now? (the same decision POST /ratings makes)',
    description:
      'Returns eligible plus a stable code (ELIGIBLE, ALREADY_RATED, NOT_COMPLETED, ENDED_EARLY_NOT_RATEABLE, NO_WORKER), a reason, the review limit and the rating scale. 404 for a booking that is not mine. Bookings also carry the `rate` action in allowedActions.',
  })
  eligibility(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingEligibilityView> {
    return this.ratings.eligibilityMine(user.userId, bookingId);
  }

  @Get('bookings/:bookingId')
  @ApiModelResponse(RatingView)
  @ApiOperation({ summary: 'My rating for one of my bookings (404 when none or not mine)' })
  forBooking(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RatingView> {
    return this.ratings.getMineForBooking(user.userId, bookingId);
  }

  @Get(':ratingId')
  @ApiModelResponse(RatingView)
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
  @ApiPageResponse(WorkerRatingView)
  @ApiOperation({ summary: 'Ratings I received, newest first (paginated, hidden ones excluded)' })
  async list(
    @Query() query: RatingListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerRatingView>> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.ratings.listReceived(ref.workerId, query);
  }

  @Get('summary')
  @ApiModelResponse(RatingSummaryView)
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
  @ApiPageResponse(AdminRatingView)
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'All ratings (paginated, filter by status/worker/booking)' })
  list(@Query() query: AdminRatingListQuery): Promise<Page<AdminRatingView>> {
    return this.ratings.adminList(query);
  }

  @Get('workers/:workerId/summary')
  @ApiModelResponse(RatingSummaryView)
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'A worker rating count and average' })
  summary(@Param('workerId', ParseUUIDPipe) workerId: string): Promise<RatingSummaryView> {
    return this.ratings.summaryFor(workerId);
  }

  @Get(':ratingId')
  @ApiModelResponse(AdminRatingView)
  @Permissions(PermissionCode.RATING_VIEW)
  @ApiOperation({ summary: 'One rating with moderation details' })
  get(@Param('ratingId', ParseUUIDPipe) ratingId: string): Promise<AdminRatingView> {
    return this.ratings.adminGet(ratingId);
  }

  @Post(':ratingId/hide')
  @ApiModelResponse(AdminRatingView)
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
  @ApiModelResponse(AdminRatingView)
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
