import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import type { Page } from '../../common/pagination/pagination';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import {
  CreateWithdrawalDto,
  CreateWorkerBankAccountDto,
  DeleteWorkerBankAccountResponse,
  PayoutListQueryDto,
  UpdateWorkerBankAccountDto,
  WalletAnalyticsQueryDto,
  WalletAnalyticsResponse,
  WalletTransactionItem,
  WalletTransactionsQueryDto,
  WithdrawalResponse,
  WorkerBankAccountResponse,
  WorkerWalletSummaryResponse,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('Worker Wallet')
@ApiBearerAuth()
@RequireUserType('WORKER')
@Controller({ path: 'workers/me', version: '1' })
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  // --- Track A: Wallet Summary ---

  @Get('wallet/summary')
  @ApiModelResponse(WorkerWalletSummaryResponse)
  @ApiOperation({
    summary: 'Get worker wallet summary',
    description:
      'Returns available balance, pending earnings, total earnings and total payouts in minor units.',
  })
  getSummary(@CurrentUser() user: AuthenticatedUser): Promise<WorkerWalletSummaryResponse> {
    return this.wallet.getSummary(user.userId);
  }

  // --- Track B: Bank Accounts ---

  @Get('bank-accounts')
  @ApiModelResponse(WorkerBankAccountResponse, { isArray: true })
  @ApiOperation({
    summary: 'List saved bank accounts',
    description: 'Returns all saved bank accounts for the worker with masked account numbers.',
  })
  listBankAccounts(@CurrentUser() user: AuthenticatedUser): Promise<WorkerBankAccountResponse[]> {
    return this.wallet.listBankAccounts(user.userId);
  }

  @Post('bank-accounts')
  @ApiModelResponse(WorkerBankAccountResponse, { status: 201 })
  @ApiOperation({
    summary: 'Add a new bank account',
    description:
      'Validates Indian IFSC and account number. The first account is automatically marked primary.',
  })
  createBankAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWorkerBankAccountDto,
  ): Promise<WorkerBankAccountResponse> {
    return this.wallet.createBankAccount(user.userId, dto);
  }

  @Put('bank-accounts/:accountId')
  @ApiModelResponse(WorkerBankAccountResponse)
  @ApiOperation({
    summary: 'Update bank account details',
    description:
      'Updates bank account info. Modifying account number or IFSC resets verification status to PENDING.',
  })
  updateBankAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: UpdateWorkerBankAccountDto,
  ): Promise<WorkerBankAccountResponse> {
    return this.wallet.updateBankAccount(user.userId, accountId, dto);
  }

  @Delete('bank-accounts/:accountId')
  @HttpCode(HttpStatus.OK)
  @ApiModelResponse(DeleteWorkerBankAccountResponse)
  @ApiOperation({
    summary: 'Deactivate / delete bank account',
    description:
      'Soft-deletes bank account. Fails if the account has in-flight withdrawals or is primary while other accounts exist.',
  })
  deleteBankAccount(
    @CurrentUser() user: AuthenticatedUser,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ): Promise<{ success: boolean }> {
    return this.wallet.deleteBankAccount(user.userId, accountId);
  }

  // --- Track C: Earnings Analytics ---

  @Get('wallet/analytics')
  @ApiModelResponse(WalletAnalyticsResponse)
  @ApiOperation({
    summary: 'Get earnings analytics and shift breakdown',
    description:
      'Provides earnings totals, daily breakdowns, and service category distributions for a selected period.',
  })
  getAnalytics(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletAnalyticsQueryDto,
  ): Promise<WalletAnalyticsResponse> {
    return this.wallet.getAnalytics(user.userId, query);
  }

  // --- Track C2: Transactions ---

  @Get('wallet/transactions')
  @ApiPageResponse(WalletTransactionItem)
  @ApiOperation({
    summary: 'List wallet transactions',
    description: 'Returns paginated ledger transactions with type and status filtering.',
  })
  listTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletTransactionsQueryDto,
  ): Promise<Page<WalletTransactionItem>> {
    return this.wallet.listTransactions(user.userId, query);
  }

  // --- Track D: Withdrawals ---

  @Post('wallet/withdrawals')
  @ApiModelResponse(WithdrawalResponse, { status: 201 })
  @ApiOperation({
    summary: 'Request a withdrawal',
    description:
      'Atomically reserves funds and creates a payout request. Minimum ₹100.00 (10000 minor units).',
  })
  requestWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<WithdrawalResponse> {
    return this.wallet.requestWithdrawal(user.userId, dto);
  }

  // --- Track D2: Payout Tracking ---

  @Get('wallet/payouts')
  @ApiPageResponse(WithdrawalResponse)
  @ApiOperation({
    summary: 'List withdrawal requests and payouts',
    description: 'Returns paginated withdrawal/payout history with status filtering.',
  })
  listPayouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PayoutListQueryDto,
  ): Promise<Page<WithdrawalResponse>> {
    return this.wallet.listPayouts(user.userId, query);
  }

  @Get('wallet/payouts/:id')
  @ApiModelResponse(WithdrawalResponse)
  @ApiOperation({
    summary: 'Get withdrawal / payout detail',
    description: 'Returns detailed information for a specific withdrawal request.',
  })
  getPayout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WithdrawalResponse> {
    return this.wallet.getPayout(user.userId, id);
  }
}
