import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { PageQueryDto } from '../../common/pagination/pagination';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const;
export const ALERT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export class AlertListQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ALERT_STATUSES, description: 'Default: everything not resolved.' })
  @IsOptional()
  @IsEnum(ALERT_STATUSES)
  status?: (typeof ALERT_STATUSES)[number];

  @ApiPropertyOptional({ enum: ALERT_SEVERITIES })
  @IsOptional()
  @IsEnum(ALERT_SEVERITIES)
  severity?: (typeof ALERT_SEVERITIES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{1,59}$/)
  type?: string;
}

export class ResolveAlertDto {
  @ApiProperty({ maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @Length(1, 1000)
  note!: string;
}

export class AlertView {
  @ApiProperty() id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ALERT_SEVERITIES }) severity!: string;
  @ApiProperty({ enum: ALERT_STATUSES }) status!: string;
  @ApiProperty() title!: string;
  @ApiProperty({ nullable: true, type: String }) entityType!: string | null;
  @ApiProperty({ nullable: true, type: String }) entityId!: string | null;
  @ApiProperty({ nullable: true }) detail!: Record<string, unknown> | null;
  @ApiProperty({ description: 'How many times the same problem was detected.' })
  occurrences!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() lastSeenAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) acknowledgedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) resolvedAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) resolutionNote!: string | null;
}
