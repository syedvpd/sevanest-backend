import { Module } from '@nestjs/common';
import { WorkersModule } from '../workers/workers.module';
import { WalletController } from './wallet.controller';
import { WalletRepository } from './wallet.repository';
import { WalletService } from './wallet.service';

@Module({
  imports: [WorkersModule],
  controllers: [WalletController],
  providers: [WalletRepository, WalletService],
  exports: [WalletService, WalletRepository],
})
export class WalletModule {}
