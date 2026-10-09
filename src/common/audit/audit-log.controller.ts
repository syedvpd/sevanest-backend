import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { Permissions } from '../decorators/auth.decorators';
import { RequireUserType } from '../decorators/user-type.decorator';
import { DomainException } from '../errors/domain.exception';
import { ErrorCode } from '../errors/error-codes';
import { Page, PageQueryDto, skipFor } from '../pagination/pagination';
import { isRealDate } from '../time/india';
import { AuditService } from './audit.service';

/** Permission code of the audit viewer (Super Admin only, see SUPER_ADMIN_ONLY_PERMISSION_CODES). */
const AUDIT_VIEW = 'audit.view';
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class AuditLogQuery extends PageQueryDto {
  @ApiPropertyOptional({ example: 'user.status_change', description: 'Exact action.' })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  action?: string;

  @ApiPropertyOptional({
    example: 'payment.',
    description: 'Action prefix, e.g. every payment action.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z_]+(\.[a-z_]*)?$/)
  @Length(1, 60)
  actionPrefix?: string;

  @ApiPropertyOptional({ example: 'booking' })
  @IsOptional()
  @IsString()
  @Length(1, 60)
  entityType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  entityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({
    description: 'The x-request-id of the request that produced the entries.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  requestId?: string;

  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'First day, India calendar, inclusive.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'from must be a date written as YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'Last day, India calendar, inclusive.',
  })
  @IsOptional()
  @Matches(DATE, { message: 'to must be a date written as YYYY-MM-DD' })
  to?: string;
}

export class AuditLogView {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true }) actorId!: string | null;
  @ApiProperty({ nullable: true }) actorRole!: string | null;
  @ApiProperty() action!: string;
  @ApiProperty() entityType!: string;
  @ApiProperty({ nullable: true }) entityId!: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Context recorded with the action; secrets and PII-like keys are already redacted.',
  })
  metadata!: unknown;
  @ApiProperty({ nullable: true }) requestId!: string | null;
  @ApiProperty() createdAt!: Date;
}

/**
 * The audit log viewer (FRD FM-15: "Super Admin can access audit logs"). Read-only: the table is append-only at the database
 * level and this controller has no write route. Newest first, always paginated.
 */
@ApiTags('Admin - Audit')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Controller({ path: 'admin/audit-logs', version: '1' })
export class AuditLogController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Permissions(AUDIT_VIEW)
  @ApiOperation({ summary: 'Search the audit log (newest first, paginated)' })
  async search(@Query() query: AuditLogQuery): Promise<Page<AuditLogView>> {
    const problems: Array<{ field: string; messages: string[] }> = [];
    for (const field of ['from', 'to'] as const) {
      const value = query[field];
      if (value !== undefined && !isRealDate(value)) {
        problems.push({ field, messages: [`${field} must be a real calendar date`] });
      }
    }
    if (problems.length === 0 && query.from && query.to && query.to < query.from) {
      problems.push({ field: 'to', messages: ['to must not be before from'] });
    }
    if (problems.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        problems,
      );
    }
    const { items, total } = await this.audit.search(
      {
        action: query.action,
        actionPrefix: query.actionPrefix,
        entityType: query.entityType,
        entityId: query.entityId,
        actorId: query.actorId,
        requestId: query.requestId,
        from: query.from ? new Date(`${query.from}T00:00:00+05:30`) : undefined,
        to: query.to ? new Date(Date.parse(`${query.to}T00:00:00+05:30`) + DAY_MS) : undefined,
      },
      skipFor(query),
      query.limit,
    );
    return { data: items, meta: { page: query.page, limit: query.limit, total } };
  }
}
