import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const toBool = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'ESCALATED', 'CLOSED'] as const;
export type TicketStatusValue = (typeof TICKET_STATUSES)[number];

/** PROPOSED vocabulary (Q-59): the specs name a priority but no scale. Set by staff only. */
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TicketPriorityValue = (typeof TICKET_PRIORITIES)[number];

/** Technical caps against abuse, not product rules (FRD FM-12 asks for a length limit without a value, Q-59). */
export const DESCRIPTION_MAX_LENGTH = 4000;
export const NOTE_MAX_LENGTH = 2000;

export class CreateTicketDto {
  @ApiProperty({ description: 'An enabled support category (GET /support/categories).' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ maxLength: DESCRIPTION_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @Length(1, DESCRIPTION_MAX_LENGTH)
  description!: string;

  @ApiPropertyOptional({
    description: 'A booking I am a party to (as the customer or as the booking worker).',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class MyTicketListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsEnum(TICKET_STATUSES)
  status?: TicketStatusValue;
}

export class AdminTicketListQuery extends MyTicketListQuery {
  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsEnum(TICKET_PRIORITIES)
  priority?: TicketPriorityValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;

  @ApiPropertyOptional({ description: 'true = only tickets nobody owns yet.' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  unassigned?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({ enum: ['CUSTOMER', 'WORKER'] })
  @IsOptional()
  @IsEnum(['CUSTOMER', 'WORKER'])
  creatorKind?: 'CUSTOMER' | 'WORKER';
}

export class AssignTicketDto {
  @ApiPropertyOptional({
    description: 'Admin user to own the ticket; defaults to me. Must hold support.manage.',
  })
  @IsOptional()
  @IsUUID()
  assigneeUserId?: string;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX_LENGTH,
    description: 'Internal note, never shown to the user.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, NOTE_MAX_LENGTH)
  note?: string;
}

export class SetPriorityDto {
  @ApiProperty({ enum: TICKET_PRIORITIES })
  @IsEnum(TICKET_PRIORITIES)
  priority!: TicketPriorityValue;
}

export class EscalateTicketDto {
  @ApiProperty({ maxLength: NOTE_MAX_LENGTH, description: 'Why it is escalated (internal).' })
  @Transform(trim)
  @IsString()
  @Length(1, NOTE_MAX_LENGTH)
  reason!: string;
}

export class CloseTicketDto {
  @ApiProperty({
    maxLength: NOTE_MAX_LENGTH,
    description:
      'The outcome. Required on close (FRD FM-12); shown to the user who raised the ticket.',
  })
  @Transform(trim)
  @IsString()
  @Length(1, NOTE_MAX_LENGTH)
  resolution!: string;
}

export class CreateSupportCategoryDto {
  @ApiProperty({ example: 'PAYMENT_ISSUE', description: 'Stable code: A-Z, 0-9, underscore.' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/)
  code!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name!: string;
}

export class UpdateSupportCategoryDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isEnabled?: boolean;
}

export class SupportCategoryView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class AdminSupportCategoryView extends SupportCategoryView {
  @ApiProperty() isEnabled!: boolean;
}

/** One line of history as the ticket creator sees it: what happened and when, never who or the staff note. */
export class TicketEventView {
  @ApiProperty() type!: string;
  @ApiProperty({ enum: TICKET_STATUSES, nullable: true }) fromStatus!: TicketStatusValue | null;
  @ApiProperty({ enum: TICKET_STATUSES, nullable: true }) toStatus!: TicketStatusValue | null;
  @ApiProperty() createdAt!: Date;
}

export class AdminTicketEventView extends TicketEventView {
  @ApiProperty() actorUserId!: string;
  @ApiProperty({ nullable: true }) internalNote!: string | null;
}

export class TicketView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: SupportCategoryView }) category!: SupportCategoryView;
  @ApiProperty({ nullable: true }) bookingId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: TICKET_STATUSES }) status!: TicketStatusValue;
  @ApiProperty({ nullable: true }) resolution!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ nullable: true }) closedAt!: Date | null;
}

export class TicketDetailView extends TicketView {
  @ApiProperty({ type: [TicketEventView] }) history!: TicketEventView[];
}

export class AdminTicketView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: SupportCategoryView }) category!: SupportCategoryView;
  @ApiProperty() creatorUserId!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKER'] }) creatorKind!: string;
  @ApiProperty({ nullable: true }) bookingId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: TICKET_STATUSES }) status!: TicketStatusValue;
  @ApiProperty({ enum: TICKET_PRIORITIES, nullable: true }) priority!: TicketPriorityValue | null;
  @ApiProperty({ nullable: true }) assignedToUserId!: string | null;
  @ApiProperty({ nullable: true }) assignedAt!: Date | null;
  @ApiProperty({ nullable: true }) escalatedAt!: Date | null;
  @ApiProperty({ nullable: true }) resolution!: string | null;
  @ApiProperty({ nullable: true }) closedAt!: Date | null;
  @ApiProperty({ nullable: true }) closedByUserId!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class AdminTicketDetailView extends AdminTicketView {
  @ApiProperty({ type: [AdminTicketEventView] }) history!: AdminTicketEventView[];
}
