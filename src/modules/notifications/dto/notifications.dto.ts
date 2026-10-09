import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { LANGUAGE_CODE } from '../../../common/validation/language';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const CHANNELS = ['PUSH', 'SMS', 'WHATSAPP'] as const;
export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;

export class CreateTemplateDto {
  @ApiProperty({
    example: 'BOOKING_CONFIRMED',
    description: 'One of the events in GET /admin/notification-events.',
  })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,59}$/)
  eventCode!: string;

  @ApiProperty({ enum: CHANNELS })
  @IsEnum(CHANNELS)
  channel!: (typeof CHANNELS)[number];

  @ApiPropertyOptional({ default: 'en' })
  @IsOptional()
  @Matches(LANGUAGE_CODE, { message: 'language must be a language code such as "en"' })
  language?: string;

  @ApiPropertyOptional({ maxLength: 120, description: 'Push title.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  title?: string;

  @ApiProperty({ maxLength: 1000, example: 'Your booking {{bookingId}} is confirmed.' })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  body!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  title?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class TemplateListQuery extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,59}$/)
  eventCode?: string;
}

export class DeliveryListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsEnum(DELIVERY_STATUSES)
  status?: (typeof DELIVERY_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,59}$/)
  eventCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  recipientUserId?: string;
}

export class TemplateView {
  @ApiProperty() id!: string;
  @ApiProperty() eventCode!: string;
  @ApiProperty({ enum: CHANNELS }) channel!: string;
  @ApiProperty() language!: string;
  @ApiProperty({ nullable: true }) title!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() updatedAt!: Date;
}

export class EventView {
  @ApiProperty() eventCode!: string;
  @ApiProperty({ type: [String], description: 'Placeholders a template may use as {{name}}.' })
  params!: string[];
}

/** Delivery log entry. Never carries the rendered text, the phone number, the push token or provider details. */
export class DeliveryView {
  @ApiProperty() id!: string;
  @ApiProperty() eventCode!: string;
  @ApiProperty({ enum: CHANNELS }) channel!: string;
  @ApiProperty({ enum: DELIVERY_STATUSES }) status!: string;
  @ApiProperty() recipientUserId!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, description: 'A stable reason code, never provider text.' })
  lastError!: string | null;
  @ApiProperty({ nullable: true }) sentAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}
