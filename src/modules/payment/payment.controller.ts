import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import {
  ApiBearerAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { Response } from 'express';
import { etagOf } from '../../common/concurrency/if-match';
import { RequireIfMatch } from '../../common/concurrency/if-match.guard';
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
  BookingFeeQuote,
  BookingFeeQuoteQuery,
  CreatePaymentDto,
  CreateFeeDto,
  CreateFeePaymentDto,
  CreatePaymentResponse,
  FEE_KINDS,
  FeeKindValue,
  UpdateFeeDto,
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

  @Get('fees/booking')
  @ApiModelResponse(BookingFeeQuote)
  @ApiOperation({
    summary: 'The booking fee I will be charged, before the payment step',
    description:
      'Same source as POST /payments, so the amount is exactly what is charged. Pass bookingId (mine) to get the amount of its already-open payment. 422 FEE_NOT_CONFIGURED when no active fee exists (then POST /payments fails the same way), 404 BOOKING_NOT_FOUND for a booking that is not mine. Cancellation, refund and replacement terms are not part of this response: no approved policy exists.',
  })
  quoteBookingFee(
    @Query() query: BookingFeeQuoteQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BookingFeeQuote> {
    return this.payments.quoteBookingFee(user.userId, query.bookingId);
  }

  @Get('fees/payable')
  @ApiOkResponse({
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          kind: { type: 'string', enum: ['PLACEMENT', 'VERIFICATION', 'REPLACEMENT_PLAN'] },
          amountMinor: { type: 'number' },
          currency: { type: 'string' },
        },
      },
    },
  })
  @ApiOperation({
    summary: 'Extra fees I can pay against a booking (placement, verification, replacement plan)',
    description:
      'Only ACTIVE fees of those kinds are listed: with none configured the list is empty and the feature is off. Pay one with POST /fee-payments.',
  })
  payableFees(): ReturnType<PaymentService['listPayableFees']> {
    return this.payments.listPayableFees();
  }

  @Idempotent()
  @Post('fee-payments')
  @ApiModelResponse(CreatePaymentResponse, { status: 201 })
  @ApiOperation({
    summary: 'Start (or resume) payment of an extra fee against my booking',
    description:
      'The amount comes from the fee configuration and cannot be sent. One open payment per booking and fee; paying a fee that is already paid answers 409 ALREADY_PAID. The booking itself does not change. 422 FEE_NOT_CONFIGURED (no active fee) / FEE_NOT_PAYABLE, 409 BOOKING_NOT_PAYABLE (cancelled), 404 for a booking that is not mine. Verify the checkout with POST /payments/{id}/verify.',
  })
  createFeePayment(
    @Body() dto: CreateFeePaymentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreatePaymentResponse> {
    return this.payments.createForFee(user.userId, dto.bookingId, dto.feeCode);
  }

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

  @Get('payments/:paymentId/receipt/pdf')
  @Header('Cache-Control', 'private, no-store')
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'The receipt as a one-page PDF (binary).' })
  @ApiOperation({
    summary: 'Receipt of one of my paid payments as a PDF',
    description:
      'Same data and errors as GET /payments/{id}/receipt (409 RECEIPT_NOT_AVAILABLE before payment, 404 for anyone else). A payment receipt, not a GST tax invoice (format not approved, Q-100).',
  })
  async receiptPdf(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const { fileName, pdf } = await this.payments.receiptPdfMine(user.userId, paymentId);
    return new StreamableFile(pdf, {
      type: 'application/pdf',
      disposition: `inline; filename="${fileName}"`,
      length: pdf.length,
    });
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
  @ApiOperation({
    summary: 'Fee catalogue (empty until an administrator sets fees, Q-01); filter by kind',
    description:
      'Each fee carries kind (BOOKING, PLACEMENT, VERIFICATION, REPLACEMENT_PLAN, SUBSCRIPTION, CANCELLATION) and updatedAt (the version for If-Match). SUBSCRIPTION and B2B models are catalogued only: nothing charges them in V1.',
  })
  fees(@Query('kind') kind?: string): Promise<FeeView[]> {
    if (kind !== undefined && !(FEE_KINDS as readonly string[]).includes(kind)) {
      throw new BadRequestException(`kind must be one of ${FEE_KINDS.join(', ')}`);
    }
    return this.payments.listFees(kind as FeeKindValue | undefined);
  }

  @Get('fees/:code')
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({ summary: 'One fee (ETag for If-Match)' })
  async fee(
    @Param('code') code: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FeeView> {
    if (!FEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException('code must be upper case letters, digits and underscores');
    }
    const fee = await this.payments.getFee(code);
    res.setHeader('ETag', etagOf(fee.updatedAt));
    return fee;
  }

  @Post('fees')
  @ApiModelResponse(FeeView, { status: 201 })
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Add a fee to the catalogue (audited)',
    description:
      '409 FEE_EXISTS. A PLACEMENT, VERIFICATION or REPLACEMENT_PLAN fee becomes payable by customers (POST /fee-payments) as soon as it is active.',
  })
  async createFee(
    @Body() dto: CreateFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<FeeView> {
    return this.payments.createFee(dto, await this.actor(admin));
  }

  @Patch('fees/:code')
  @RequireIfMatch()
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Change a fee amount or switch it on/off (If-Match required: 428 without it, 412 when stale)',
    description: 'A fee already used by a payment is deactivated, not deleted.',
  })
  async updateFee(
    @Param('code') code: string,
    @Body() dto: UpdateFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<FeeView> {
    if (!FEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException('code must be upper case letters, digits and underscores');
    }
    return this.payments.updateFee(code, dto, await this.actor(admin), ifMatch);
  }

  @Delete('fees/:code')
  @RequireIfMatch()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: 'Delete a fee that was never charged (If-Match required)',
    description: '409 FEE_IN_USE once any payment used it; 409 FEE_PROTECTED for the booking fee.',
  })
  async deleteFee(
    @Param('code') code: string,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    if (!FEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException('code must be upper case letters, digits and underscores');
    }
    await this.payments.deleteFee(code, await this.actor(admin), ifMatch);
  }

  @Put('fees/booking-fee')
  @RequireIfMatch()
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary: `Set the booking/platform fee (${BOOKING_FEE_CODE}); audited with before and after`,
  })
  async setBookingFee(
    @Body() dto: SetFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<FeeView> {
    return this.payments.setFee(BOOKING_FEE_CODE, dto, await this.actor(admin), ifMatch);
  }

  @Put('fees/:code')
  @RequireIfMatch()
  @ApiModelResponse(FeeView)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({
    summary:
      'Set any configured fee by code (placement, verification, replacement plan ...); audited with before and after',
    description:
      'Create-or-replace upsert (use POST/PATCH /admin/fees for the catalogue). Fee values are configuration (PRD 10). BOOKING_FEE is charged by the booking flow; PLACEMENT, VERIFICATION and REPLACEMENT_PLAN fees are charged through POST /fee-payments; others are catalogued only. Send If-Match: * when the code does not exist yet.',
  })
  async setFee(
    @Param('code') code: string,
    @Body() dto: SetFeeDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<FeeView> {
    if (!FEE_CODE_PATTERN.test(code)) {
      throw new BadRequestException('code must be upper case letters, digits and underscores');
    }
    return this.payments.setFee(code, dto, await this.actor(admin), ifMatch);
  }

  private async actor(admin: AuthenticatedUser): Promise<PaymentActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
