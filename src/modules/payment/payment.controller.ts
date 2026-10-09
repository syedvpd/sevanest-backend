import {
  Body,
  Controller,
  Get,
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
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
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
  FeeView,
  PaymentListQuery,
  PaymentView,
  RefundDto,
  SetFeeDto,
  VerifyPaymentDto,
  WebhookAck,
} from './dto/payment.dto';
import { PaymentActor, PaymentService } from './payment.service';

/** A customer's own payments (FRD FM-07). The amount is never taken from the client. */
@ApiTags('Payments')
@ApiBearerAuth()
@RequireUserType('CUSTOMER')
@Controller({ version: '1' })
export class PaymentsController {
  constructor(private readonly payments: PaymentService) {}

  @Post('payments')
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

  @Post('payments/:paymentId/verify')
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
  @ApiOperation({ summary: 'My transaction history, newest first (paginated)' })
  list(
    @Query() query: PaymentListQuery,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<Page<PaymentView>> {
    return this.payments.listMine(user.userId, query);
  }

  @Get('payments/:paymentId')
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
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({
    summary: 'All payments, newest first (paginated, filter by status/booking/customer)',
  })
  list(@Query() query: AdminPaymentListQuery): Promise<Page<AdminPaymentView>> {
    return this.payments.adminList(query);
  }

  @Get('payments/:paymentId')
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({ summary: 'A payment with the gateway references kept for reconciliation' })
  get(@Param('paymentId', ParseUUIDPipe) paymentId: string): Promise<AdminPaymentView> {
    return this.payments.adminGet(paymentId);
  }

  @Post('payments/:paymentId/reconcile')
  @HttpCode(HttpStatus.OK)
  @Permissions(PermissionCode.PAYMENT_MANAGE)
  @ApiOperation({ summary: 'Ask the gateway for the real outcome and apply it (idempotent)' })
  async reconcile(
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminPaymentView> {
    return this.payments.reconcile(paymentId, await this.actor(admin));
  }

  @Post('payments/:paymentId/refund')
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

  @Get('fees')
  @Permissions(PermissionCode.PAYMENT_VIEW)
  @ApiOperation({ summary: 'Configured fees (empty until an administrator sets them, Q-01)' })
  fees(): Promise<FeeView[]> {
    return this.payments.listFees();
  }

  @Put('fees/booking-fee')
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

  private async actor(admin: AuthenticatedUser): Promise<PaymentActor> {
    const access = await this.users.getAccess(admin.userId);
    return { userId: admin.userId, roles: access.roles };
  }
}
