import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const WAGE_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE', 'OTHER'] as const;
export type WagePaymentMethodValue = (typeof WAGE_PAYMENT_METHODS)[number];

/** One wage payment made OFF the platform (V1 is not payroll): staff record it so the worker can see it. */
export class RecordWagePaymentDto {
  @ApiProperty({ minimum: 1, description: 'Amount in paise (smallest currency unit).' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amountMinor!: number;

  @ApiProperty({
    example: '2026-11',
    description: 'Free label for what the payment covers (month, week, "advance" ...).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 40)
  periodLabel!: string;

  @ApiProperty({ enum: WAGE_PAYMENT_METHODS })
  @IsEnum(WAGE_PAYMENT_METHODS)
  method!: WagePaymentMethodValue;

  @ApiProperty({
    maxLength: 200,
    description:
      'Reference the worker can recognise (UPI id, receipt number, "paid in cash on 3 Nov" ...).',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  referenceText!: string;
}

/** Recording a new entry also names the booking (the path `admin/bookings/:id/...` is taken by Booking's generic action route). */
export class CreateWagePaymentDto extends RecordWagePaymentDto {
  @ApiProperty({ format: 'uuid', description: 'A started booking that has a worker.' })
  @IsUUID()
  bookingId!: string;
}

export class VoidWagePaymentDto {
  @ApiProperty({
    maxLength: 200,
    description: 'Why the entry is cancelled; kept as the reference of the voiding row.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  reason!: string;
}

export class AdminWagePaymentQuery extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  workerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class WagePaymentView {
  @ApiProperty() id!: string;
  @ApiProperty() bookingId!: string;
  @ApiProperty() amountMinor!: number;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty() periodLabel!: string;
  @ApiProperty({ enum: WAGE_PAYMENT_METHODS }) method!: WagePaymentMethodValue;
  @ApiProperty() referenceText!: string;
  @ApiProperty() recordedAt!: Date;
}

export class AdminWagePaymentView extends WagePaymentView {
  @ApiProperty() workerId!: string;
  @ApiProperty() recordedByUserId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The earlier row this one replaces or cancels.',
  })
  correctsId!: string | null;
  @ApiProperty({
    description: 'A cancelling row: it removes the row it points to from the totals.',
  })
  isVoid!: boolean;
  @ApiProperty({
    description: 'True once a later row corrected or voided this one (it no longer counts).',
  })
  superseded!: boolean;
}

export class EarningsTotalsView {
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ description: 'Sum of the entries that count (not corrected, not voided).' })
  amountMinor!: number;
  @ApiProperty() paymentCount!: number;
}

export class EarningsPageMeta {
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
  @ApiProperty() total!: number;
}

export class WorkerEarningsView {
  @ApiProperty({ type: [WagePaymentView] }) data!: WagePaymentView[];
  @ApiProperty({ type: EarningsPageMeta }) meta!: EarningsPageMeta;
  @ApiProperty({
    type: EarningsTotalsView,
    description:
      "Totals over ALL of the worker's counted entries, not just this page. Information only: the platform does not pay wages.",
  })
  totals!: EarningsTotalsView;
}
