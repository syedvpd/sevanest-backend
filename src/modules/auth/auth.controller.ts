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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, Public } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { AuthService, LoginResult } from './auth.service';
import {
  AdminLoginDto,
  OtpRequestedResponse,
  RefreshTokenDto,
  RegisterDeviceTokenDto,
  RequestOtpDto,
  SessionResponse,
  TokenResponse,
  VerifyOtpDto,
} from './dto/auth.dto';
import { SessionService } from './session.service';

function clientIp(request: Request): string {
  return request.ip ?? 'unknown';
}

function toTokenResponse(result: LoginResult): TokenResponse {
  return {
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    tokenType: 'Bearer',
    expiresIn: result.expiresIn,
    user: result.user,
  };
}

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send a login OTP to a customer or worker mobile number',
    description:
      'Rate limited per mobile and per IP; 429 responses carry details[0] (retryAfterSeconds). Suspended accounts are refused before anything is sent.',
  })
  requestOtp(@Body() dto: RequestOtpDto, @Req() request: Request): Promise<OtpRequestedResponse> {
    return this.auth.requestOtp(dto.mobile, dto.appType, clientIp(request));
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify the OTP and start a session',
    description:
      'Creates the account on first verification (user.isNewUser = true, then create the profile). The OTP is single-use.',
  })
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<TokenResponse> {
    const result = await this.auth.verifyOtp(dto, {
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
    });
    return toTokenResponse(result);
  }

  @Public()
  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login with email and password',
    description:
      'Repeated failures lock the account and the client IP for a configured time (429, ADMIN_LOGIN_LOCKED).',
  })
  async adminLogin(@Body() dto: AdminLoginDto, @Req() request: Request): Promise<TokenResponse> {
    const result = await this.auth.adminLogin(dto, clientIp(request), {
      deviceId: dto.deviceId,
      deviceName: dto.deviceName,
    });
    return toTokenResponse(result);
  }

  @Public()
  @Post('token/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token and get a new access token',
    description:
      'The refresh token is single-use. Presenting an already-used token revokes the session (possible token theft).',
  })
  async refresh(@Body() dto: RefreshTokenDto): Promise<TokenResponse> {
    const issued = await this.sessions.refresh(dto.refreshToken);
    return {
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      tokenType: 'Bearer',
      expiresIn: issued.expiresIn,
      user: { id: issued.userId, type: issued.userType, isNewUser: false },
    };
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current session and its push token' })
  async logout(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.sessions.revokeCurrent(user.userId, user.sessionId);
  }

  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'List my active sessions (one per device)' })
  async listSessions(@CurrentUser() user: AuthenticatedUser): Promise<SessionResponse[]> {
    const rows = await this.sessions.listActive(user.userId);
    return rows.map((row) => ({
      id: row.id,
      deviceName: row.deviceName,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      current: row.id === user.sessionId,
    }));
  }

  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one of my own sessions' })
  async revokeSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.sessions.revokeOwn(user.userId, sessionId);
  }

  @ApiBearerAuth()
  @RequireUserType('CUSTOMER', 'WORKER')
  @Put('device-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Bind the device push token to the current session' })
  async registerDeviceToken(
    @Body() dto: RegisterDeviceTokenDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.sessions.registerDeviceToken(user.userId, user.sessionId, dto.token, dto.platform);
  }
}
