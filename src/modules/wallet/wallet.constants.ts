export const WalletErrorCode = {
  BANK_ACCOUNT_NOT_FOUND: 'BANK_ACCOUNT_NOT_FOUND',
  BANK_ACCOUNT_IN_USE: 'BANK_ACCOUNT_IN_USE',
  BANK_ACCOUNT_NOT_VERIFIED: 'BANK_ACCOUNT_NOT_VERIFIED',
  CANNOT_DELETE_PRIMARY_ACCOUNT: 'CANNOT_DELETE_PRIMARY_ACCOUNT',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  MINIMUM_WITHDRAWAL_REQUIRED: 'MINIMUM_WITHDRAWAL_REQUIRED',
  PAYOUT_NOT_FOUND: 'PAYOUT_NOT_FOUND',
  DUPLICATE_IDEMPOTENCY_KEY: 'DUPLICATE_IDEMPOTENCY_KEY',
  ACTIVE_WITHDRAWAL_EXISTS: 'ACTIVE_WITHDRAWAL_EXISTS',
} as const;

export const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  HOUSE_MAID: 'House Cleaning',
  COOK: 'Cooking & Meal Prep',
  DRIVER: 'Family Driver',
  BABYSITTER: 'Child Supervision',
  ELDERLY_CARE_HELPER: 'Elderly Care',
  CLEANING_HELPER: 'Cleaning Helper',
};

export function maskAccountNumber(accountNumber: string): string {
  if (!accountNumber) return '';
  if (accountNumber.length <= 4) return accountNumber;
  const last4 = accountNumber.slice(-4);
  const maskedPrefix = '•'.repeat(Math.max(accountNumber.length - 4, 8));
  return `${maskedPrefix}${last4}`;
}
