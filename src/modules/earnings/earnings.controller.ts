import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { PageQueryDto } from '../../common/pagination/pagination';
import type { Page } from '../../common/pagination/pagination';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { WorkersService } from '../workers/workers.service';
import {
  AdminWagePaymentQuery,
  AdminWagePaymentView,
  CreateWagePaymentDto,
  RecordWagePaymentDto,
  VoidWagePaymentDto,
  WorkerEarningsView,
} from './dto/earnings.dto';
import { EarningsActor, EarningsService } from './earnings.service';

/** The worker's own earnings reference: payments staff recorded as made off-platform, plus their total. Read only. */
@ApiTags('Earnings')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me/earnings', version: '1' })
export class WorkerEarningsController {
  constructor(
    private readonly earnings: EarningsService,
    private readonly workers: WorkersService,
  ) {}

  @Get()
  @ApiModelResponse(WorkerEarningsView)
  @ApiOperation({
    summary: 'My earnings reference: wage payments recorded by staff, newest first, with my total',
    description:
      'Information only: SevaNest does not pay wages (V1 is not payroll). Corrected or cancelled entries are not shown or counted. `totals` covers all of my counted entries, not only this page.',
  })
  async list(
    @Query() query: PageQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WorkerEarningsView> {
    const ref = await this.workers.requireRefByUserId(user.userId);
    return this.earnings.listForWorker(ref.workerId, query);
  }
}

/** Staff record, correct and void wage payments made off-platform (append-only, audited). */
@ApiTags('Admin - Earnings')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminEarningsController {
  constructor(
    private readonly earnings: EarningsService,
    private readonly users: UsersService,
  ) {}

  @Idempotent()
  @Post('wage-payments')
  @ApiModelResponse(AdminWagePaymentView, { status: 201 })
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Record a wage payment made off-platform for the worker of a started booking (audited)',
    description:
      '409 NO_WORKER_ASSIGNED / BOOKING_NOT_STARTED; 404 for an unknown booking. The platform moves no money.',
  })
  async record(
    @Body() dto: CreateWagePaymentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWagePaymentView> {
    return this.earnings.record(dto.bookingId, dto, await this.actor(admin));
  }

  @Idempotent()
  @Post('wage-payments/:id/correct')
  @ApiModelResponse(AdminWagePaymentView, { status: 201 })
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Correct an entry with a new one (the old row stays as history and stops counting)',
    description:
      '409 WAGE_PAYMENT_ALREADY_CORRECTED when a newer row already replaced it; 409 WAGE_PAYMENT_IS_VOID for a cancelling row.',
  })
  async correct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordWagePaymentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWagePaymentView> {
    return this.earnings.correct(id, dto, await this.actor(admin));
  }

  @Idempotent()
  @Post('wage-payments/:id/void')
  @ApiModelResponse(AdminWagePaymentView, { status: 201 })
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Cancel an entry that should not exist (a new voiding row; the old one stays as history)',
  })
  async voidEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidWagePaymentDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminWagePaymentView> {
    return this.earnings.voidEntry(id, dto, await this.actor(admin));
  }

  @Get('wage-payments')
  @ApiPageResponse(AdminWagePaymentView)
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({
    summary:
      'All wage payment entries including corrections and voids (paginated, filter by worker or booking)',
  })
  list(@Query() query: AdminWagePaymentQuery): Promise<Page<AdminWagePaymentView>> {
    return this.earnings.listForAdmin(query);
  }

  private async actor(admin: AuthenticatedUser): Promise<EarningsActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
