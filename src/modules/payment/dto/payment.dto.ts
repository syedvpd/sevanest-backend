import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** C-05: the vocabulary is the architecture document's, with SUCCEEDED spelled out. */
export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
  'REFUND_FAILED',
] as const;
export type PaymentStatusValue = (typeof PAYMENT_STATUSES)[number];

/** The only documented fee: the booking/platform fee (FR-BK-004). Other fee types are open (Q-01). */
export const BOOKING_FEE_CODE = 'BOOKING_FEE';

export class CreatePaymentDto {
  @ApiProperty({ description: 'My booking that is waiting for payment.' })
  @IsUUID()
  bookingId!: string;
}

export class VerifyPaymentDto {
  @ApiProperty({ description: 'The payment id the gateway SDK reported.' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  providerPaymentId!: string;

  @ApiProperty({
    description: 'The signature the gateway SDK reported. It is verified by the server.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  signature!: string;
}

export class RefundDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  reason!: string;
}

export class SetFeeDto {
  @ApiProperty({ minimum: 1, description: 'Amount in the smallest currency unit (paise).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  amountMinor!: number;

  @ApiPropertyOptional({ default: 'INR' })
  @IsOptional()
  @Matches(/^INR$/, { message: 'currency must be INR' })
  currency?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PaymentListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsEnum(PAYMENT_STATUSES)
  status?: PaymentStatusValue;

  @ApiPropertyOptional({ description: 'Only payments of this booking.' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description:
      'true = every refund state (REFUND_PENDING, REFUNDED, REFUND_FAILED). Ignored when status is given.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  refunded?: boolean;
}

export class AdminPaymentListQuery extends PaymentListQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerUserId?: string;
}

export class FeeView {
  @ApiProperty() code!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() isActive!: boolean;
}

export class PaymentView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ enum: PAYMENT_STATUSES }) status!: PaymentStatusValue;
  @ApiProperty({ description: 'Smallest currency unit (paise).' }) amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({
    nullable: true,
    description: 'Receipt number once the payment succeeded (FR-PAY-002).',
    type: String,
  })
  receiptNumber!: string | null;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'],
    description: 'Refund status where applicable (FR-PAY-004).',
  })
  refundStatus!: 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_FAILED' | null;
  @ApiProperty({ nullable: true, type: Date }) refundedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'upi',
    description:
      'How it was paid, as the gateway reports it (upi, card, netbanking, wallet, emi). Null until the gateway answers.',
  })
  paymentMethod!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'ab***@okhdfc',
    description:
      'Masked detail: card network and last 4, masked UPI id, bank or wallet code. Never a full number.',
  })
  paymentMethodDetail!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'pay_29QQoUBi66xm2f',
    description: 'The gateway payment id (show it on the receipt; quote it to support).',
  })
  gatewayReference!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Gateway error code of a FAILED payment.',
  })
  failureCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Gateway message of a FAILED payment, suitable for display. Null otherwise.',
  })
  failureReason!: string | null;
}

export class CheckoutView {
  @ApiProperty({ enum: ['razorpay', 'fake'], description: 'Which SDK to open.' }) gateway!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Razorpay key id (public). Pass as `key` to the Razorpay SDK. Null for the fake gateway.',
  })
  keyId!: string | null;
  @ApiProperty({ description: 'Gateway order id. Pass as `order_id` to the Razorpay SDK.' })
  orderId!: string;
  @ApiProperty({ description: 'Smallest currency unit (paise).' }) amount!: number;
  @ApiProperty() currency!: string;
}

export class CreatePaymentResponse extends PaymentView {
  @ApiProperty({
    type: CheckoutView,
    nullable: true,
    description:
      'What the gateway SDK needs to open the checkout. Null while the gateway order cannot be created yet.',
  })
  checkout!: CheckoutView | null;
}

export class ReceiptView {
  @ApiProperty() receiptNumber!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty({ example: 'BOOKING_FEE', description: 'What was paid for.' }) feeCode!: string;
  @ApiProperty({ description: 'Smallest currency unit (paise).' }) amountMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() paidAt!: Date;
  @ApiProperty({ nullable: true, type: String }) paymentMethod!: string | null;
  @ApiProperty({ nullable: true, type: String }) paymentMethodDetail!: string | null;
  @ApiProperty({ nullable: true, type: String }) gatewayReference!: string | null;
  @ApiProperty({ enum: PAYMENT_STATUSES }) status!: PaymentStatusValue;
  @ApiProperty({
    nullable: true,
    type: String,
    enum: ['REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'],
  })
  refundStatus!: 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_FAILED' | null;
  @ApiProperty({ nullable: true, type: Date }) refundedAt!: Date | null;
}

export class AdminPaymentView extends PaymentView {
  @ApiProperty() customerUserId!: string;
  @ApiProperty() feeCode!: string;
  @ApiProperty({
    nullable: true,
    description: 'Gateway reference kept for reconciliation (FR-PAY-008).',
    type: String,
  })
  providerOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String }) providerPaymentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) refundReason!: string | null;
  @ApiProperty({ nullable: true, type: String }) refundedByUserId!: string | null;
}

export class WebhookAck {
  @ApiProperty() received!: boolean;
}

export const EXCEPTION_KINDS = [
  'PAID_BOOKING_CANCELLED',
  'LATE_PAYMENT_BOOKING_NOT_PENDING',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'DUPLICATE_PAYMENT',
  'UNKNOWN_ORDER_EVENT',
  'RECONCILIATION_EXHAUSTED',
  'REFUND_STUCK',
  'REFUND_NOT_REQUESTED',
] as const;

export class PaymentExceptionListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'RESOLVED'] })
  @IsOptional()
  @IsEnum(['OPEN', 'RESOLVED'])
  status?: 'OPEN' | 'RESOLVED';

  @ApiPropertyOptional({ enum: EXCEPTION_KINDS })
  @IsOptional()
  @IsEnum(EXCEPTION_KINDS)
  kind?: (typeof EXCEPTION_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  paymentId?: string;
}

export class ResolveExceptionDto {
  @ApiProperty({
    maxLength: 1000,
    description: 'What was done (e.g. refunded at the gateway, confirmed no action needed).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  note!: string;
}

/** A date range for an export: both ends required, at most one year (a technical cap, not a reporting rule). */
export class PaymentExportQuery {
  @ApiProperty({ example: '2026-10-01', description: 'First day (India date), inclusive.' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date in YYYY-MM-DD form' })
  from!: string;

  @ApiProperty({
    example: '2026-10-31',
    description: 'Last day (India date), inclusive; at most 366 days after from.',
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date in YYYY-MM-DD form' })
  to!: string;
}

export const FEE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,49}$/;
