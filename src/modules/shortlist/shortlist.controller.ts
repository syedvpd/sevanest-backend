import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
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
import { ShortlistCategoryCountView, ShortlistItemView, ShortlistQuery } from './dto/shortlist.dto';
import { ShortlistService } from './shortlist.service';

/** The signed-in customer's own shortlist (FR-WD-005). */
@ApiTags('Shortlist')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'shortlist', version: '1' })
export class ShortlistController {
  constructor(private readonly shortlist: ShortlistService) {}

  @Get()
  @ApiExtraModels(ShortlistItemView, ShortlistCategoryCountView)
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'meta', 'categoryCounts'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(ShortlistItemView) } },
        meta: {
          type: 'object',
          properties: {
            page: { type: 'number' },
            limit: { type: 'number' },
            total: { type: 'number' },
          },
        },
        categoryCounts: {
          type: 'array',
          items: { $ref: getSchemaPath(ShortlistCategoryCountView) },
        },
      },
    },
  })
  @ApiOperation({
    summary: 'My shortlisted workers, newest first (paginated; optional category filter)',
    description:
      'Each entry carries the customer-safe card when the worker is still visible (`available: true`), otherwise only the id. `category` keeps only workers offering that category; `meta.total` is then the size of the filtered list. `categoryCounts` ([{ code, name, count }]) covers the whole shortlist, independent of the page and the filter.',
  })
  list(
    @Query() query: ShortlistQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<ShortlistItemView> & { categoryCounts: ShortlistCategoryCountView[] }> {
    return this.shortlist.list(user.userId, query);
  }

  @Put(':workerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Shortlist a worker (idempotent)',
    description:
      '404 WORKER_NOT_FOUND for an unknown worker and for one who is not visible to customers (same answer); 422 SHORTLIST_FULL at 100 entries (technical guard).',
  })
  async add(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.shortlist.add(user.userId, workerId);
  }

  @Delete(':workerId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a worker from my shortlist (idempotent)' })
  async remove(
    @Param('workerId', ParseUUIDPipe) workerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.shortlist.remove(user.userId, workerId);
  }
}
