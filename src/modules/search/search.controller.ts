import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { PageQueryDto } from '../../common/pagination/pagination';
import {
  SearchWorkersQuery,
  SlotsQuery,
  WorkerCard,
  WorkerReviewView,
  WorkerSlotsView,
} from './dto/search.dto';
import { SearchService } from './search.service';

/** Worker discovery for customers (FRD FM-03). Read-only. */
@ApiTags('Search')
@ApiBearerAuth()
@ApiExtraModels(WorkerCard)
@RequireUserType('CUSTOMER')
@Controller({ path: 'search/workers', version: '1' })
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOkResponse({
    schema: {
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(WorkerCard) } },
        meta: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            limit: { type: 'number' },
            total: { type: 'number' },
          },
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Find verified workers by category, location and availability (paginated)',
    description:
      'Returns worker cards only: no name, contact details, address, salary or documents. A worker is listed only when active, profile submitted and fully verified. 422 CATEGORY_NOT_AVAILABLE / AREA_NOT_AVAILABLE for a category or area that is unknown or disabled. Order is a stable sort on experience, not a relevance ranking.',
  })
  find(
    @Query() query: SearchWorkersQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<WorkerCard>> {
    return this.search.searchForCustomer(query, user.userId);
  }

  @Get(':workerId/ratings')
  @ApiPageResponse(WorkerReviewView)
  @ApiOperation({
    summary: "A worker's reviews (paginated, newest first)",
    description:
      'Score, comment, createdAt and the reviewer first name only. Reviews hidden by moderation are not listed. 404 WORKER_NOT_FOUND exactly as for the profile (unknown or not visible to customers). `meta.total` is the number of visible reviews.',
  })
  reviews(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<WorkerReviewView>> {
    return this.search.listReviews(workerId, query);
  }

  @Get(':workerId/slots')
  @ApiModelResponse(WorkerSlotsView)
  @ApiOperation({
    summary: 'Free interview or trial start times of a worker on one date',
    description:
      'One-hour slots inside the worker availability windows, minus held bookings and confirmed interviews, within the next 14 days (today included; today only from one hour ahead). 404 WORKER_NOT_FOUND exactly as for the profile; 400 for a date outside the horizon.',
  })
  slots(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @Query() query: SlotsQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerSlotsView> {
    return this.search.listSlots(workerId, query, user.userId);
  }

  @Get(':workerId')
  @ApiOkResponse({ type: WorkerCard })
  @ApiOperation({
    summary: 'The customer-safe profile of one worker',
    description:
      'Same allow-list as a card: no name, contact, address, salary, documents or account id. 404 WORKER_NOT_FOUND for an unknown id AND for a worker who is not currently visible (not submitted, suspended, not fully verified or re-check due): the answers are identical.',
  })
  profile(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerCard> {
    return this.search.getProfile(workerId, user.userId);
  }
}
