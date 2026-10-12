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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { ShortlistItemView, ShortlistQuery } from './dto/shortlist.dto';
import { ShortlistService } from './shortlist.service';

/** The signed-in customer's own shortlist (FR-WD-005). */
@ApiTags('Shortlist')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ path: 'shortlist', version: '1' })
export class ShortlistController {
  constructor(private readonly shortlist: ShortlistService) {}

  @Get()
  @ApiOperation({
    summary: 'My shortlisted workers, newest first (paginated)',
    description:
      'Each entry carries the customer-safe card when the worker is still visible (`available: true`), otherwise only the id.',
  })
  list(
    @Query() query: ShortlistQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<ShortlistItemView>> {
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
