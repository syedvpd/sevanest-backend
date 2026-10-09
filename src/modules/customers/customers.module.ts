import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { CustomerAddressesService } from './customer-addresses.service';
import { AdminCustomersController, CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

/**
 * Customers: customer profile and saved addresses (SRS 3.2, FRD FM-02) plus admin customer management. Owns its tables;
 * reads account data (mobile, account status) only through Users' exported service.
 */
@Module({
  imports: [UsersModule],
  controllers: [CustomersController, AdminCustomersController],
  providers: [CustomersRepository, CustomersService, CustomerAddressesService],
  exports: [CustomersService],
})
export class CustomersModule {}
