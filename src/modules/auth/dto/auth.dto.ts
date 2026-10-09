import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsIndianMobile } from '../../../common/validation/indian-mobile';

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Technical bounds only (they stop absurd payloads); they are not product limits. */
const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export class RequestOtpDto {
  @ApiProperty({
    example: '9876543210',
    description: 'Indian mobile number; +91 / 91 / 0 prefixes accepted.',
  })
  @IsIndianMobile()
  mobile!: string;

  @ApiProperty({
    enum: ['CUSTOMER', 'WORKER'],
    description: 'Which app is signing in; decides the account type.',
  })
  @IsIn(['CUSTOMER', 'WORKER'])
  appType!: 'CUSTOMER' | 'WORKER';
}

export class VerifyOtpDto extends RequestOtpDto {
  @ApiProperty({
    example: '123456',
    description: 'Digits only. The length is server configuration.',
  })
  @IsString()
  @Matches(/^[0-9]{4,10}$/, { message: 'otp must contain digits only' })
  otp!: string;

  @ApiPropertyOptional({
    description: 'Client-generated install id. One active session per device.',
  })
  @IsOptional()
  @Matches(DEVICE_ID, { message: 'deviceId has an invalid format' })
  deviceId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class AdminLoginDto {
  @ApiProperty({ example: 'ops.lead@example.com' })
  @Transform(lowerTrim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @Length(1, 256)
  password!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DEVICE_ID, { message: 'deviceId has an invalid format' })
  deviceId?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  deviceName?: string;
}

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The current refresh token. It is single-use: a new one is returned.',
  })
  @IsString()
  @Length(20, 200)
  refreshToken!: string;
}

export class RegisterDeviceTokenDto {
  @ApiProperty({ description: 'FCM registration token for this device.' })
  @IsString()
  @Length(1, 1024)
  token!: string;

  @ApiProperty({ enum: ['ANDROID', 'IOS'] })
  @IsIn(['ANDROID', 'IOS'])
  platform!: 'ANDROID' | 'IOS';
}

export class OtpRequestedResponse {
  @ApiProperty({ description: 'Seconds until the OTP expires.' }) expiresInSeconds!: number;
  @ApiProperty({ description: 'Seconds before another OTP may be requested for this number.' })
  resendAfterSeconds!: number;
}

export class AuthUserSummary {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER', 'ADMIN'] }) type!: string;
  @ApiProperty({
    description: 'True when this verification created the account (continue to profile creation).',
  })
  isNewUser!: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Admin role codes.' }) roles?: string[];
}

export class TokenResponse {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ description: 'Opaque, single-use. Store securely.' }) refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: 'Bearer';
  @ApiProperty({ description: 'Access-token lifetime in seconds.' }) expiresIn!: number;
  @ApiProperty({ type: AuthUserSummary }) user!: AuthUserSummary;
}

export class SessionResponse {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) deviceName!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) lastUsedAt!: Date | null;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty({ description: 'True for the session making this request.' }) current!: boolean;
}
