import { Global, Module } from '@nestjs/common';
import {
  AccountDeletionController,
  AdminDeletionController,
  LegalController,
} from './legal.controller';
import { LegalService } from './legal.service';

/** Consent and account-deletion requests (global: Booking asks whether the current terms are accepted). Depends on Alerts and Audit only. */
@Global()
@Module({
  controllers: [LegalController, AccountDeletionController, AdminDeletionController],
  providers: [LegalService],
  exports: [LegalService],
})
export class LegalModule {}
