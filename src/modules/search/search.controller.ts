import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { SearchWorkersQuery, WorkerCard } from './dto/search.dto';
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
  find(@Query() query: SearchWorkersQuery): Promise<Page<WorkerCard>> {
    return this.search.searchForCustomer(query);
  }
}
