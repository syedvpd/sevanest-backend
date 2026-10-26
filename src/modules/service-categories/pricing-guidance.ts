import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { AuditService } from '../../common/audit/audit.service';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { isForeignKeyViolation, isUniqueViolation } from '../../common/errors/prisma-errors';
import { Page, PageQueryDto, skipFor } from '../../common/pagination/pagination';
import { ApiModelResponse, ApiPageResponse } from '../../common/swagger/api-responses';
import { ENGAGEMENTS, type Engagement } from '../../common/validation/engagements';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { PermissionCode } from '../users/rbac.constants';
import { UsersService } from '../users/users.service';
import { ServiceCategoriesService } from './service-categories.service';

export const PRICE_PERIODS = ['HOUR', 'DAY', 'MONTH', 'ONE_TIME'] as const;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class PricingGuidanceQuery {
  @ApiProperty({ example: 'COOK', description: 'Category code.' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category!: string;

  @ApiPropertyOptional({
    description: 'A guidance row for this area wins over the category-wide one.',
  })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiProperty({ enum: ENGAGEMENTS })
  @IsIn(ENGAGEMENTS)
  engagement!: Engagement;
}

export class PricingGuidanceResponse {
  @ApiProperty({ description: 'Lower end, in paise (smallest currency unit).' }) minMinor!: number;
  @ApiProperty({ description: 'Upper end, in paise.' }) maxMinor!: number;
  @ApiProperty({ enum: PRICE_PERIODS }) period!: string;
  @ApiProperty({ description: 'Short text to show with the band.' }) basis!: string;
}

export class AdminPricingGuidanceResponse extends PricingGuidanceResponse {
  @ApiProperty() id!: string;
  @ApiProperty() categoryCode!: string;
  @ApiProperty({ nullable: true, type: String }) areaId!: string | null;
  @ApiProperty({ enum: ENGAGEMENTS }) engagement!: string;
  @ApiProperty() updatedAt!: Date;
}

export class SetPricingGuidanceDto {
  @ApiProperty({ example: 'COOK' })
  @Transform(trim)
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,49}$/)
  category!: string;

  @ApiPropertyOptional({ description: 'Omit for a category-wide band.' })
  @IsOptional()
  @IsUUID()
  areaId?: string;

  @ApiProperty({ enum: ENGAGEMENTS })
  @IsIn(ENGAGEMENTS)
  engagement!: Engagement;

  @ApiProperty({ minimum: 1, description: 'Paise.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  minMinor!: number;

  @ApiProperty({ description: 'Paise; not below minMinor.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  maxMinor!: number;

  @ApiProperty({ enum: PRICE_PERIODS })
  @IsIn(PRICE_PERIODS)
  period!: (typeof PRICE_PERIODS)[number];

  @ApiProperty({ example: 'Typical for Hyderabad, set by SevaNest', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(1, 200)
  basis!: string;
}

/**
 * Price guidance for the customer Budget step. The numbers are entered by an administrator (nobody derives or guesses them); with none
 * entered the customer endpoint answers 404 and the app simply hides the card. Owned by Service Categories (the catalogue).
 */
@Injectable()
export class PricingGuidanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: ServiceCategoriesService,
    private readonly audit: AuditService,
  ) {}

  async forCustomer(query: PricingGuidanceQuery): Promise<PricingGuidanceResponse> {
    const category = await this.categories.requireEnabledByCode(query.category);
    const rows = await this.prisma.pricingGuidance.findMany({
      where: {
        categoryId: category.id,
        engagement: query.engagement,
        OR: [{ areaId: null }, ...(query.areaId ? [{ areaId: query.areaId }] : [])],
      },
    });
    const row = rows.find((r) => r.areaId !== null) ?? rows[0];
    if (!row) {
      throw new DomainException(
        'PRICING_GUIDANCE_NOT_FOUND',
        'There is no price guidance for this selection',
        HttpStatus.NOT_FOUND,
      );
    }
    return { minMinor: row.minMinor, maxMinor: row.maxMinor, period: row.period, basis: row.basis };
  }

  async adminList(query: PageQueryDto): Promise<Page<AdminPricingGuidanceResponse>> {
    const [rows, total] = await Promise.all([
      this.prisma.pricingGuidance.findMany({
        include: { category: { select: { code: true } } },
        orderBy: [{ categoryId: 'asc' }, { engagement: 'asc' }, { id: 'asc' }],
        skip: skipFor(query),
        take: query.limit,
      }),
      this.prisma.pricingGuidance.count(),
    ]);
    return {
      data: rows.map((r) => this.toAdmin(r, r.category.code)),
      meta: { page: query.page, limit: query.limit, total },
    };
  }

  /** Creates the band for category + engagement (+ area) or replaces the existing one. */
  async adminSet(
    dto: SetPricingGuidanceDto,
    actor: { userId: string; roles: string[] },
  ): Promise<AdminPricingGuidanceResponse> {
    if (dto.maxMinor < dto.minMinor) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        [{ field: 'maxMinor', messages: ['maxMinor must not be below minMinor'] }],
      );
    }
    const category = await this.categories.requireEnabledByCode(dto.category);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.pricingGuidance.findFirst({
          where: {
            categoryId: category.id,
            areaId: dto.areaId ?? null,
            engagement: dto.engagement,
          },
        });
        const data = {
          minMinor: dto.minMinor,
          maxMinor: dto.maxMinor,
          period: dto.period,
          basis: dto.basis,
        };
        const saved = existing
          ? await tx.pricingGuidance.update({ where: { id: existing.id }, data })
          : await tx.pricingGuidance.create({
              data: {
                ...data,
                categoryId: category.id,
                areaId: dto.areaId ?? null,
                engagement: dto.engagement,
              },
            });
        await this.audit.record(
          {
            action: existing ? 'pricing_guidance.update' : 'pricing_guidance.create',
            entityType: 'pricing_guidance',
            entityId: saved.id,
            actorId: actor.userId,
            actorRole: actor.roles.join(',') || null,
            metadata: {
              category: category.code,
              engagement: dto.engagement,
              areaId: dto.areaId ?? null,
            },
          },
          tx,
        );
        return saved;
      });
      return this.toAdmin(row, category.code);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new DomainException('AREA_NOT_FOUND', 'Service area not found', HttpStatus.NOT_FOUND);
      }
      if (isUniqueViolation(error)) {
        throw new DomainException('PRICING_GUIDANCE_CONFLICT', 'Please retry', HttpStatus.CONFLICT);
      }
      throw error;
    }
  }

  async adminDelete(id: string, actor: { userId: string; roles: string[] }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.pricingGuidance.findUnique({ where: { id } });
      if (!row) {
        throw new DomainException(
          'PRICING_GUIDANCE_NOT_FOUND',
          'Price guidance not found',
          HttpStatus.NOT_FOUND,
        );
      }
      await tx.pricingGuidance.delete({ where: { id } });
      await this.audit.record(
        {
          action: 'pricing_guidance.delete',
          entityType: 'pricing_guidance',
          entityId: id,
          actorId: actor.userId,
          actorRole: actor.roles.join(',') || null,
          metadata: {},
        },
        tx,
      );
    });
  }

  private toAdmin(
    r: {
      id: string;
      areaId: string | null;
      engagement: string;
      minMinor: number;
      maxMinor: number;
      period: string;
      basis: string;
      updatedAt: Date;
    },
    categoryCode: string,
  ): AdminPricingGuidanceResponse {
    return {
      id: r.id,
      categoryCode,
      areaId: r.areaId,
      engagement: r.engagement,
      minMinor: r.minMinor,
      maxMinor: r.maxMinor,
      period: r.period,
      basis: r.basis,
      updatedAt: r.updatedAt,
    };
  }
}

@ApiTags('Pricing')
@ApiBearerAuth()
@RequireUserType('CUSTOMER', 'WORKER')
@Controller({ path: 'pricing', version: '1' })
export class PricingGuidanceController {
  constructor(private readonly pricing: PricingGuidanceService) {}

  @Get('guidance')
  @ApiModelResponse(PricingGuidanceResponse)
  @ApiOperation({
    summary:
      'Typical price band for the Budget step (404 PRICING_GUIDANCE_NOT_FOUND when none is set)',
  })
  guidance(@Query() query: PricingGuidanceQuery): Promise<PricingGuidanceResponse> {
    return this.pricing.forCustomer(query);
  }
}

@ApiTags('Admin - Service Categories')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Permissions(PermissionCode.CATEGORY_MANAGE)
@Controller({ path: 'admin/pricing-guidance', version: '1' })
export class AdminPricingGuidanceController {
  constructor(
    private readonly pricing: PricingGuidanceService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiPageResponse(AdminPricingGuidanceResponse)
  @ApiOperation({ summary: 'List price guidance rows (paginated)' })
  list(@Query() query: PageQueryDto): Promise<Page<AdminPricingGuidanceResponse>> {
    return this.pricing.adminList(query);
  }

  @Put()
  @ApiModelResponse(AdminPricingGuidanceResponse)
  @ApiOperation({
    summary:
      'Set (create or replace) the band for a category + engagement, optionally for one area',
  })
  async set(
    @Body() dto: SetPricingGuidanceDto,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<AdminPricingGuidanceResponse> {
    const access = await this.users.getAccess(admin.userId);
    return this.pricing.adminSet(dto, { userId: admin.userId, roles: access.roles });
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a price guidance row' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<void> {
    const access = await this.users.getAccess(admin.userId);
    await this.pricing.adminDelete(id, { userId: admin.userId, roles: access.roles });
  }
}
