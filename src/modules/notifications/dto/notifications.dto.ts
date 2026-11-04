import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';
import { LANGUAGE_CODE } from '../../../common/validation/language';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const CHANNELS = ['PUSH', 'SMS', 'WHATSAPP', 'EMAIL', 'IN_APP'] as const;
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

  @ApiPropertyOptional({
    maxLength: 64,
    description: 'India DLT: the registered template id this wording belongs to (SMS).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  dltTemplateId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTemplateDto {
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  dltTemplateId?: string;

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
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({ nullable: true, type: String }) dltTemplateId!: string | null;
  @ApiProperty() isActive!: boolean;
  @ApiProperty() updatedAt!: Date;
}

export class InboxQuery extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Only unread items.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  @IsBoolean()
  unreadOnly?: boolean;
}

/** One in-app message. `route` tells the app where a tap should go (deep link); `params` are ids only. */
export class InboxItemView {
  @ApiProperty() id!: string;
  @ApiProperty() event!: string;
  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty() body!: string;
  @ApiProperty({
    nullable: true,
    example: { type: 'booking', id: 'uuid' },
    description:
      'Where a tap leads. `type` is one of booking | ticket | replacement | payment (the first id the event carries, in that order); `id` is that entity id. null when the event names no entity.',
  })
  route!: { type: string; id: string } | null;
  @ApiProperty({ nullable: true, type: Date }) readAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class UnreadCountView {
  @ApiProperty({ description: 'Unread in-app notifications of the signed-in user (the badge).' })
  count!: number;
  @ApiProperty({ description: 'Same number as `count`; kept for older clients.', deprecated: true })
  unread!: number;
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
  @ApiProperty({
    nullable: true,
    description: 'A stable reason code, never provider text.',
    type: String,
  })
  lastError!: string | null;
  @ApiProperty({ nullable: true, type: Date }) sentAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class TestPushDto {
  @ApiPropertyOptional({
    example: 'SevaNest Test Notification',
    description: 'Custom test push title. Defaults to "SevaNest Test Notification".',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  title?: string;

  @ApiPropertyOptional({
    example: 'Your push notification setup is working successfully!',
    description:
      'Custom test push body text. Defaults to "Your push notification setup is working successfully!".',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  body?: string;

  @ApiPropertyOptional({
    example: 'flutter-diag-01J2ABCDEF',
    description:
      'Optional client correlation id (max 64 characters). Echoed in the response and written to the audit record so an app log can be matched to a backend dispatch.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 64)
  correlationId?: string;
}

/** Administrator variant: an explicit recipient instead of the caller's own devices. */
export class AdminTestPushDto extends TestPushDto {
  @ApiProperty({
    description: 'The customer or worker whose registered device(s) receive the test push.',
  })
  @IsUUID()
  userId!: string;
}

export class TestPushTokenResult {
  @ApiProperty({ description: 'Masked device token for privacy' })
  token!: string;

  @ApiProperty({ enum: ['DELIVERED', 'FAILED'] })
  status!: 'DELIVERED' | 'FAILED';

  @ApiPropertyOptional({ description: 'FCM message ID when delivered successfully' })
  providerMessageId?: string;

  @ApiPropertyOptional({
    description: 'Stable error code when delivery failed (never provider text)',
  })
  error?: string;
}

export class TestPushDiagnostics {
  @ApiProperty({ description: 'Whether active device token(s) are registered with backend' })
  tokenRegistered!: boolean;

  @ApiProperty({ description: 'Whether backend push provider is active (fcm or mock)' })
  fcmConfigured!: boolean;

  @ApiProperty({ description: 'Number of device tokens that successfully received the test push' })
  deliveredCount!: number;

  @ApiProperty({ description: 'Number of device tokens that failed dispatch' })
  failedCount!: number;

  @ApiProperty({
    description: 'Guidance for handling notifications in the Flutter foreground state (onMessage)',
  })
  foregroundHandlingNote!: string;

  @ApiProperty({
    description: 'Guidance for handling notifications in the Flutter background/terminated state',
  })
  backgroundHandlingNote!: string;

  @ApiPropertyOptional({
    description:
      'Actionable troubleshooting advice indicating whether an issue originates from the app or backend',
  })
  troubleshootingRecommendation?: string;
}

export class TestPushResponse {
  @ApiProperty({ description: 'Overall success of the test push dispatch' })
  success!: boolean;

  @ApiProperty({
    description:
      'Correlation id echoed from the request, or a generated one. Quote it when reporting a delivery problem.',
  })
  correlationId!: string;

  @ApiPropertyOptional({
    description: 'Diagnostic ID (matches correlationId for tracing)',
  })
  diagnostic_id?: string;

  @ApiPropertyOptional({
    description: 'Whether Firebase/FCM provider is initialized and configured',
  })
  firebase_initialized?: boolean;

  @ApiPropertyOptional({ description: 'Whether active device registration was found for user' })
  registration_found?: boolean;

  @ApiPropertyOptional({ description: 'Number of active device tokens found' })
  active_token_count?: number;

  @ApiPropertyOptional({ description: 'Whether dispatch was attempted to FCM' })
  dispatch_attempted?: boolean;

  @ApiPropertyOptional({ description: 'Number of device tokens accepted by Firebase' })
  firebase_accepted_count?: number;

  @ApiPropertyOptional({ description: 'Number of device tokens rejected by Firebase' })
  firebase_failure_count?: number;

  @ApiPropertyOptional({
    description: 'Normalized diagnostic outcome code',
    enum: [
      'FCM_ACCEPTED',
      'NO_ACTIVE_DEVICE_TOKEN',
      'FIREBASE_NOT_INITIALIZED',
      'INVALID_FCM_TOKEN',
      'FCM_DISPATCH_FAILED',
    ],
  })
  result?: string;

  @ApiProperty({
    enum: ['CONFIG_ERROR', 'NO_DEVICE_TOKEN', 'DISPATCHED', 'FAILED'],
    description: 'Diagnostic stage identifying whether an issue is in the app or backend',
  })
  stage!: 'CONFIG_ERROR' | 'NO_DEVICE_TOKEN' | 'DISPATCHED' | 'FAILED';

  @ApiProperty({ description: 'Human-readable explanation of result and next steps' })
  message!: string;

  @ApiProperty({ description: 'Active FCM push provider configured on backend' })
  pushProvider!: string;

  @ApiProperty({ description: 'Firebase Project ID targeted' })
  firebaseProjectId!: string;

  @ApiProperty({ description: 'Number of device tokens found for this authenticated user' })
  tokensCount!: number;

  @ApiProperty({
    type: [TestPushTokenResult],
    description: 'Detailed dispatch result per device token',
  })
  tokens!: TestPushTokenResult[];

  @ApiProperty({
    type: TestPushDiagnostics,
    description: 'Diagnostic notes for Flutter foreground/background handling',
  })
  diagnostics!: TestPushDiagnostics;

  @ApiProperty({ description: 'Server timestamp of test dispatch' })
  dispatchedAt!: Date;
}

export class NotificationAckDto {
  @ApiProperty({
    enum: ['RECEIVED', 'DISPLAYED', 'TAPPED'],
    description: 'Telemetry event reported by mobile client',
  })
  @IsIn(['RECEIVED', 'DISPLAYED', 'TAPPED'])
  eventType!: 'RECEIVED' | 'DISPLAYED' | 'TAPPED';

  @ApiPropertyOptional({ description: 'Client timestamp when event occurred on device' })
  @IsOptional()
  @IsString()
  deviceTimestamp?: string;
}

export class NotificationAckResponse {
  @ApiProperty() acknowledged!: boolean;
  @ApiProperty({ enum: ['RECEIVED', 'DISPLAYED', 'TAPPED'] }) eventType!: string;
  @ApiProperty() notificationId!: string;
}
