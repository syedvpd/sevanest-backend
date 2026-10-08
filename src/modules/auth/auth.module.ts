import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfigService } from '../../config/app-config.service';
import { AuthRepository } from './auth.repository';
import { AuthorizationService } from './authorization.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { RolesGuard } from './guards/roles.guard';
import { TokenService } from './token.service';

/**
 * Auth & Session: FOUNDATION SLICE ONLY (token mechanism + guards). OTP login, refresh/logout endpoints and admin
 * credential login belong to the Auth module proper and are intentionally not implemented yet.
 * The guards are registered globally, in a fixed order, by AppModule.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtAccessSecret,
        signOptions: { expiresIn: config.jwtAccessTtlSeconds },
      }),
    }),
  ],
  providers: [
    AuthRepository,
    AuthorizationService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
  ],
  exports: [
    AuthRepository,
    AuthorizationService,
    TokenService,
    JwtAuthGuard,
    RolesGuard,
    PermissionsGuard,
  ],
})
export class AuthModule {}
