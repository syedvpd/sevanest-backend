import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
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

export const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_NUMBER_REGEX = /^[0-9]{9,18}$/;
export const MIN_WITHDRAWAL_MINOR = 10000; // ₹100.00 in minor units

// --- Track A: Wallet Summary ---

export class WorkerWalletSummaryResponse {
  @ApiProperty({
    example: 450000,
    description: 'Available balance for withdrawal in minor currency units (paise).',
  })
  availableBalanceMinor!: number;

  @ApiProperty({ example: 50000, description: 'Pending earnings in minor currency units.' })
  pendingEarningsMinor!: number;

  @ApiProperty({
    example: 500000,
    description: 'Total historical earnings to date in minor currency units.',
  })
  totalEarningsMinor!: number;

  @ApiProperty({
    example: 100000,
    description: 'Total amount already paid/withdrawn to date in minor currency units.',
  })
  totalPaidMinor!: number;

  @ApiProperty({ example: 'INR', description: 'Currency code.' })
  currency!: string;

  @ApiProperty({ nullable: true, type: Date, description: 'Last balance update timestamp.' })
  updatedAt!: Date | null;
}

// --- Track B: Bank Accounts ---

export class CreateWorkerBankAccountDto {
  @ApiProperty({
    example: 'Ramesh Kumar',
    description: 'Name of the account holder as per bank records.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  accountHolderName!: string;

  @ApiProperty({ example: 'State Bank of India', description: 'Name of the bank.' })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  bankName!: string;

  @ApiProperty({ example: '123456789012', description: 'Bank account number (9 to 18 digits).' })
  @Transform(trim)
  @IsString()
  @Matches(ACCOUNT_NUMBER_REGEX, { message: 'accountNumber must be between 9 and 18 digits' })
  accountNumber!: string;

  @ApiProperty({ example: 'SBIN0001234', description: '11-character Indian IFSC code.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(IFSC_REGEX, {
    message: 'ifscCode must be a valid 11-character Indian IFSC (e.g., SBIN0001234)',
  })
  ifscCode!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this account should be the primary withdrawal account.',
  })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateWorkerBankAccountDto {
  @ApiPropertyOptional({ example: 'Ramesh Kumar' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  accountHolderName?: string;

  @ApiPropertyOptional({ example: 'State Bank of India' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  bankName?: string;

  @ApiPropertyOptional({ example: '123456789012' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(ACCOUNT_NUMBER_REGEX, { message: 'accountNumber must be between 9 and 18 digits' })
  accountNumber?: string;

  @ApiPropertyOptional({ example: 'SBIN0001234' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(IFSC_REGEX, { message: 'ifscCode must be a valid 11-character Indian IFSC' })
  ifscCode?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class WorkerBankAccountResponse {
  @ApiProperty({ example: '0192e47b-1234-7000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'Ramesh Kumar' })
  accountHolderName!: string;

  @ApiProperty({ example: 'State Bank of India' })
  bankName!: string;

  @ApiProperty({ example: '••••••••9012', description: 'Masked bank account number.' })
  accountNumberMasked!: string;

  @ApiProperty({ example: 'SBIN0001234' })
  ifscCode!: string;

  @ApiProperty({ enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'], example: 'VERIFIED' })
  verificationStatus!: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

  @ApiProperty({ example: true })
  isPrimary!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

// --- Track C: Analytics ---

export const AnalyticsPeriods = [
  'THIS_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'ALL_TIME',
  'CUSTOM',
] as const;
export type AnalyticsPeriodValue = (typeof AnalyticsPeriods)[number];

export class WalletAnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: AnalyticsPeriods,
    default: 'THIS_MONTH',
    description: 'Filter period for earnings analytics.',
  })
  @IsOptional()
  @IsIn(AnalyticsPeriods)
  period?: AnalyticsPeriodValue;

  @ApiPropertyOptional({
    example: '2026-11-01',
    description: 'Start date (YYYY-MM-DD) for CUSTOM period.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-11-30',
    description: 'End date (YYYY-MM-DD) for CUSTOM period.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;
}

export class DailyEarningsItem {
  @ApiProperty({ example: '2026-11-05' })
  date!: string;

  @ApiProperty({ example: 150000, description: 'Earnings in minor units on this date.' })
  earningsMinor!: number;

  @ApiProperty({ example: 2, description: 'Completed shifts on this date.' })
  shiftsCount!: number;
}

export class CategoryEarningsItem {
  @ApiProperty({ example: 'HOUSE_MAID' })
  categoryCode!: string;

  @ApiProperty({ example: 'House Cleaning' })
  categoryName!: string;

  @ApiProperty({ example: 300000, description: 'Total earnings in minor units for this category.' })
  earningsMinor!: number;

  @ApiProperty({ example: 4, description: 'Completed shifts for this category.' })
  completedShiftsCount!: number;

  @ApiProperty({ example: 66.67, description: 'Percentage of total earnings (0-100).' })
  percentage!: number;
}

export class WalletAnalyticsResponse {
  @ApiProperty({ enum: AnalyticsPeriods, example: 'THIS_MONTH' })
  period!: string;

  @ApiProperty({ example: '2026-11-01' })
  from!: string;

  @ApiProperty({ example: '2026-11-30' })
  to!: string;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ example: 450000, description: 'Total earnings for the period in minor units.' })
  totalEarningsMinor!: number;

  @ApiProperty({ example: 6, description: 'Total completed shifts count for the period.' })
  completedShiftsCount!: number;

  @ApiProperty({ type: [DailyEarningsItem] })
  dailyEarnings!: DailyEarningsItem[];

  @ApiProperty({ type: [CategoryEarningsItem] })
  categoryBreakdown!: CategoryEarningsItem[];
}

// --- Track C2: Transactions ---

export class WalletTransactionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['CREDIT', 'DEBIT'] })
  @IsOptional()
  @IsIn(['CREDIT', 'DEBIT'])
  type?: 'CREDIT' | 'DEBIT';

  @ApiPropertyOptional({ enum: ['PENDING', 'SETTLED', 'FAILED', 'REVERSED'] })
  @IsOptional()
  @IsIn(['PENDING', 'SETTLED', 'FAILED', 'REVERSED'])
  status?: 'PENDING' | 'SETTLED' | 'FAILED' | 'REVERSED';
}

export class WalletTransactionItem {
  @ApiProperty({ example: '0192e47b-1234-7000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: 100000, description: 'Transaction amount in minor currency units.' })
  amountMinor!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({ enum: ['CREDIT', 'DEBIT'], example: 'CREDIT' })
  type!: 'CREDIT' | 'DEBIT';

  @ApiProperty({ enum: ['PENDING', 'SETTLED', 'FAILED', 'REVERSED'], example: 'SETTLED' })
  status!: 'PENDING' | 'SETTLED' | 'FAILED' | 'REVERSED';

  @ApiProperty({ example: 'Booking wage payout for BK-123' })
  description!: string;

  @ApiProperty({ example: 'BOOKING_PAYOUT' })
  referenceType!: string;

  @ApiProperty({ nullable: true, type: String, example: '0192e47b-0000-7000-8000-000000000001' })
  referenceId!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

// --- Track D & D2: Withdrawals & Payouts ---

export class CreateWithdrawalDto {
  @ApiProperty({
    example: 15000,
    minimum: MIN_WITHDRAWAL_MINOR,
    description:
      'Withdrawal amount in minor currency units (paise). Minimum ₹100.00 (10000 minor).',
  })
  @IsInt()
  @Min(MIN_WITHDRAWAL_MINOR, {
    message: `amountMinor must be at least ${MIN_WITHDRAWAL_MINOR} (₹100)`,
  })
  @Max(100000000, { message: 'amountMinor exceeds maximum allowed per transaction' })
  amountMinor!: number;

  @ApiProperty({
    example: '0192e47b-1234-7000-8000-000000000001',
    description: 'ID of saved bank account.',
  })
  @IsUUID()
  bankAccountId!: string;

  @ApiPropertyOptional({
    example: 'req-withdrawal-12345',
    description: 'Idempotency key to prevent double withdrawals.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  idempotencyKey?: string;
}

export class WithdrawalResponse {
  @ApiProperty({ example: '0192e47b-1234-7000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: 15000, description: 'Amount in minor units.' })
  amountMinor!: number;

  @ApiProperty({ example: 'INR' })
  currency!: string;

  @ApiProperty({
    enum: ['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED'],
    example: 'REQUESTED',
  })
  status!: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REJECTED' | 'CANCELLED';

  @ApiProperty({ example: '0192e47b-1234-7000-8000-000000000001' })
  bankAccountId!: string;

  @ApiProperty({ example: 'State Bank of India (••••••••9012)' })
  bankAccountMasked!: string;

  @ApiProperty({ nullable: true, type: String })
  failureReason!: string | null;

  @ApiProperty()
  requestedAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  processedAt!: Date | null;
}

export class PayoutListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED'],
  })
  @IsOptional()
  @IsIn(['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED'])
  status?: 'REQUESTED' | 'PROCESSING' | 'PAID' | 'FAILED' | 'REJECTED' | 'CANCELLED';
}
