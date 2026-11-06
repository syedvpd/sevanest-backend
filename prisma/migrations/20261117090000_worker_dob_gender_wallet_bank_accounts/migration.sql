-- CreateEnum
CREATE TYPE "WorkerGender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "BankAccountVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WalletLedgerType" AS ENUM ('EARNING', 'EARNING_RELEASE', 'WITHDRAWAL_RESERVE', 'WITHDRAWAL_PAID', 'WITHDRAWAL_CANCELLED', 'WITHDRAWAL_FAILED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "WalletLedgerStatus" AS ENUM ('PENDING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkerWithdrawalStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "worker_profiles" ADD COLUMN "date_of_birth" DATE;
ALTER TABLE "worker_profiles" ADD COLUMN "gender" "WorkerGender";

-- CreateTable
CREATE TABLE "worker_bank_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_id" UUID NOT NULL,
    "account_holder_name" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_number" TEXT NOT NULL,
    "account_number_masked" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "verification_status" "BankAccountVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(6),
    "verified_by_user_id" UUID,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_bank_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_wallets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_id" UUID NOT NULL,
    "available_balance_minor" INTEGER NOT NULL DEFAULT 0,
    "pending_balance_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_wallet_ledgers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "type" "WalletLedgerType" NOT NULL,
    "status" "WalletLedgerStatus" NOT NULL DEFAULT 'COMPLETED',
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "reference_type" TEXT,
    "reference_id" TEXT,
    "description" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_wallet_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "worker_withdrawals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wallet_id" UUID NOT NULL,
    "worker_id" UUID NOT NULL,
    "bank_account_id" UUID NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "WorkerWithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "bank_account_masked" TEXT NOT NULL,
    "idempotency_key" TEXT,
    "failure_reason" TEXT,
    "provider_reference" TEXT,
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_withdrawals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_bank_accounts_worker_id_is_deleted_idx" ON "worker_bank_accounts"("worker_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "worker_wallets_worker_id_key" ON "worker_wallets"("worker_id");

-- CreateIndex
CREATE UNIQUE INDEX "worker_wallet_ledgers_idempotency_key_key" ON "worker_wallet_ledgers"("idempotency_key");

-- CreateIndex
CREATE INDEX "worker_wallet_ledgers_worker_id_created_at_idx" ON "worker_wallet_ledgers"("worker_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "worker_withdrawals_idempotency_key_key" ON "worker_withdrawals"("idempotency_key");

-- CreateIndex
CREATE INDEX "worker_withdrawals_worker_id_status_created_at_idx" ON "worker_withdrawals"("worker_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "worker_bank_accounts" ADD CONSTRAINT "worker_bank_accounts_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_wallets" ADD CONSTRAINT "worker_wallets_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "worker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_wallet_ledgers" ADD CONSTRAINT "worker_wallet_ledgers_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "worker_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_withdrawals" ADD CONSTRAINT "worker_withdrawals_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "worker_wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_withdrawals" ADD CONSTRAINT "worker_withdrawals_bank_account_id_fkey" FOREIGN KEY ("bank_account_id") REFERENCES "worker_bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

