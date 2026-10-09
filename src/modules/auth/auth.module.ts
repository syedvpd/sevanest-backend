import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { SmsProviderKind } from '../../config/env.validation';
import { DisabledSmsProvider } from '../../integrations/notifications/disabled-sms.provider';
import { InMemorySmsProvider } from '../../integrations/notifications/in-memory-sms.provider';
import { SMS_PROVIDER } from '../../integrations/notifications/notification-providers.interface';
import { UsersModule } from '../users/users.module';
import { AdminLoginThrottle } from './admin-login-throttle.service';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthorizationService } from './authorization.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';
import { OtpService } from './otp.service';
import { SessionRepository } from './session.repository';
import { SessionService } from './session.service';
import { TokenService } from './token.service';

/**
 * Auth & Session: mobile OTP login (customers, workers), credential login (admins), token sessions with rotating
 * refresh tokens, logout/revocation, and the global authentication/authorization guards (registered by AppModule in a
 * fixed order). Depends on Users for accounts; Users never depends on Auth.
 */
@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: { expiresIn: config.jwtAccessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthRepository,
    AuthorizationService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
    SessionRepository,
    SessionService,
    OtpService,
    AdminLoginThrottle,
    AuthService,
    {
      provide: SMS_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        config.smsProvider === SmsProviderKind.Memory
          ? new InMemorySmsProvider()
          : new DisabledSmsProvider(),
    },
  ],
  exports: [
    AuthRepository,
    AuthorizationService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
    SessionService,
    SMS_PROVIDER,
  ],
})
export class AuthModule {}
