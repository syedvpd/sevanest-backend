import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Idempotent } from '../../common/idempotency/idempotency.interceptor';
import { CurrentUser, Permissions, Public } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import {
  AdminPaymentListQuery,
  AdminPaymentView,
  BOOKING_FEE_CODE,
  CreatePaymentDto,
  CreatePaymentResponse,
  FEE_CODE_PATTERN,
  FeeView,
  PaymentExceptionListQuery,
  PaymentExportQuery,
  PaymentListQuery,
  PaymentView,
  ReceiptView,
  RefundDto,
  ResolveExceptionDto,
  SetFeeDto,
  VerifyPaymentDto,
  WebhookAck,
} from './dto/payment.dto';
import { ExceptionView, PaymentActor, PaymentService } from './payment.service';

/** A customer's own payments (FRD FM-07). The amount is never taken from the client. */
@ApiTags('Payments')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentService) {}

  @Idempotent()
  @Post('payments')
  @ApiModelResponse(CreatePaymentResponse, { status: 201 })
  @ApiOperation({
    summary: 'Start (or resume) payment of my booking that is waiting for payment',
    description:
      'The amount comes from the fee configuration. Calling again while a payment is open returns the same payment. 409 BOOKING_NOT_PAYABLE, 422 FEE_NOT_CONFIGURED, 503 PAYMENT_PROVIDER_UNAVAILABLE.',
  })
  create(
    @Body() dto: CreatePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreatePaymentResponse> {
    return this.payments.createForBooking(user.userId, dto.bookingId);
  }

  @Idempotent()
  @Post('payments/:paymentId/verify')
  @ApiModelResponse(PaymentView)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report a finished checkout; the server verifies it with the gateway',
    description:
      'What the client says is only a hint: an invalid signature answers 400 PAYMENT_VERIFICATION_FAILED and changes nothing; the state comes from the gateway.',
  })
  verify(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: VerifyPaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentView> {
    return this.payments.verifyReported(user.userId, paymentId, dto);
  }

  @Get('payments')
  @ApiPageResponse(PaymentView)
  @ApiOperation({ summary: 'My transaction history, newest first (paginated)' })
  list(
    @Query() query: PaymentListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<PaymentView>> {
    return this.payments.listMine(user.userId, query);
  }

  @Get('payments/:paymentId/receipt')
  @ApiModelResponse(ReceiptView)
  @ApiOperation({
    summary:
      'Receipt of one of my paid payments (409 RECEIPT_NOT_AVAILABLE before payment, 404 for anyone else)',
  })
  receipt(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReceiptView> {
    return this.payments.receiptMine(user.userId, paymentId);
  }

  @Get('payments/:paymentId')
  @ApiModelResponse(PaymentView)
  @ApiOperation({
    summary: 'One of my payments with its receipt and refund status (404 for anyone else)',
  })
  get(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaymentView> {
    return this.payments.getMine(user.userId, paymentId);
  }
}

/**
 * The gateway calls this; it carries no user session. It is public ONLY in the sense of authentication guards - the request
 * is authenticated by the provider signature over the raw body, checked by the adapter before anything else happens.
 */
@ApiTags('Payments')
@Controller({ path: 'webhooks/payments', version: '1' })
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentService) {}

  @Post()
  @ApiModelResponse(WebhookAck)
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | undefined>,
  ): Promise<WebhookAck> {
    return this.payments.handleWebhook(req.rawBody, headers);
  }
}

/** Staff-side payments, fees and refunds (FR-PAY-008, FRD FM-07). Every change is audited. */
@ApiTags('Admin - Payments')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin', version: '1' })
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentService,
    private readonly users: UsersService,
  ) {}

  @Get('payments')
  @ApiPageResponse(AdminPaymentView)
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({
    summary: 'All payments, newest first (paginated, filter by status/booking/customer)',
  })
  list(@Query() query: AdminPaymentListQuery): Promise<Page<AdminPaymentView>> {
    return this.payments.adminList(query);
  }

  @Get('payments-export')
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="payments.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Payments created in a date range as a CSV file (invoice/reference export)',
    description:
      'from and to are required (India dates, at most 366 days apart). At most 5000 rows (413 beyond: shorten the range). Ids and gateway references only - no customer name, mobile or card data. Audited.',
  })
  async exportCsv(
    @Query() query: PaymentExportQuery,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<string> {
    return this.payments.exportCsv(query, await this.actor(admin));
  }

  @Get('payments/:paymentId')
  @ApiModelResponse(AdminPaymentView)
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({ summary: 'A payment with the gateway references kept for reconciliation' })
  get(@Param('paymentId', ParseUUIDPipe) paymentId: string): Promise<AdminPaymentView> {
    return this.payments.adminGet(paymentId);
  }

  @Idempotent()
  @Post('payments/:paymentId/reconcile')
  @ApiModelResponse(AdminPaymentView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Ask the gateway for the real outcome and apply it (idempotent)' })
  async reconcile(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminPaymentView> {
    return this.payments.reconcile(paymentId, await this.actor(admin));
  }

  @Idempotent()
  @Post('payments/:paymentId/refund')
  @ApiModelResponse(AdminPaymentView)
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.PAYMENT_REFUND)
  @ApiOperation({
    summary: 'Refund a succeeded payment in full (reason required; repeating is safe)',
    description:
      'Who may refund and the cancellation fee rules are open (Q-17, Q-21): nothing is refunded automatically.',
  })
  async refund(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: RefundDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminPaymentView> {
    return this.payments.refund(paymentId, dto, await this.actor(admin));
  }

  @Get('payment-exceptions')
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({
    summary:
      'Money problems that need a person (late payment for a cancelled booking, mismatch, duplicate, stuck refund)',
    description:
      'Each item states the booking and payment state, the amount, the gateway references and the required action. Nothing is refunded automatically (refund policy open, Q-17/Q-21).',
  })
  exceptions(@Query() query: PaymentExceptionListQuery): Promise<Page<ExceptionView>> {
    return this.payments.listExceptions(query);
  }

  @Post('payment-exceptions/:exceptionId/resolve')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Close a money problem after a person dealt with it (note required; audited)',
    description:
      'Moves no money. Refund through POST /admin/payments/{id}/refund first when a refund is due.',
  })
  async resolveException(
    @Param('exceptionId', ParseUUIDPipe) exceptionId: string,
    @Body() dto: ResolveExceptionDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<ExceptionView> {
    return this.payments.resolveException(exceptionId, dto.note, await this.actor(admin));
  }

  @Get('payment-recovery/summary')
  @ApiModelResponse(FeeView, { isArray: true })
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({
    summary: 'Recovery queue health: checks due, open money problems, webhooks without an order',
    description:
      'A growing "dueForCheck" with an old "oldestDueSeconds" means the worker process is not running.',
  })
  recovery(): ReturnType<PaymentService['recoverySummary']> {
    return this.payments.recoverySummary();
  }

  @Get('fees')
  @ApiModelResponse(FeeView, { isArray: true })
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({ summary: 'Configured fees (empty until an administrator sets them, Q-01)' })
  fees(): Promise<FeeView[]> {
    return this.payments.listFees();
  }

  @Put('fees/booking-fee')
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: `Set the booking/platform fee (${BOOKING_FEE_CODE}); audited with before and after`,
  })
  async setBookingFee(
    @Body() dto: SetFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<FeeView> {
    return this.payments.setFee(BOOKING_FEE_CODE, dto, await this.actor(admin));
  }

  @Put('fees/:code')
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Set any configured fee by code (placement, verification, replacement plan ...); audited with before and after',
    description:
      'Fee values are configuration (PRD 10). Only BOOKING_FEE is charged by the current flows; other codes are stored for the revenue models the business enables later.',
  })
  async setFee(
    @Param('code') code: string,
    @Body() dto: SetFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<FeeView> {
    if (!FEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException('code must be upper case letters, digits and underscores');
    }
    return this.payments.setFee(code, dto, await this.actor(admin));
  }

  private async actor(admin: AuthenticatedUser): Promise<PaymentActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
