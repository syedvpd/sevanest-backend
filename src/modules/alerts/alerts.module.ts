import { Global, Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AdminAlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

/** Staff alerts (global so any module can raise one in its own transaction). Depends only on Users and Audit. */
@Global()
@Module({
  imports: [UsersModule],
  controllers: [AdminAlertsController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}
