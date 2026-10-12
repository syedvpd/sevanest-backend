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
}

export class AdminPaymentListQuery extends PaymentListQuery {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;

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
  })
  receiptNumber!: string | null;
  @ApiProperty({ nullable: true }) paidAt!: Date | null;
  @ApiProperty({ nullable: true, description: 'Refund status where applicable (FR-PAY-004).' })
  refundStatus!: 'REFUND_PENDING' | 'REFUNDED' | 'REFUND_FAILED' | null;
  @ApiProperty({ nullable: true }) refundedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class CreatePaymentResponse extends PaymentView {
  @ApiProperty({
    nullable: true,
    description: 'What the gateway SDK needs to open the checkout. Public data only.',
  })
  checkout!: Record<string, unknown> | null;
}

export class AdminPaymentView extends PaymentView {
  @ApiProperty() customerUserId!: string;
  @ApiProperty() feeCode!: string;
  @ApiProperty({
    nullable: true,
    description: 'Gateway reference kept for reconciliation (FR-PAY-008).',
  })
  providerOrderId!: string | null;
  @ApiProperty({ nullable: true }) providerPaymentId!: string | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty({ nullable: true }) refundReason!: string | null;
  @ApiProperty({ nullable: true }) refundedByUserId!: string | null;
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
