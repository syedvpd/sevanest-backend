import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { RATING_TAGS } from '../../common/rating/rating-tags';
import { LegalCurrentView } from '../legal/legal.dto';
import { Public } from '../../common/decorators/auth.decorators';
import { AppConfigService } from '../../config/app-config.service';
import { BOOKING_STATUS_LABELS, BUDGET_PERIODS } from '../booking/dto/booking.dto';
import { INTERVIEW_STATUS_LABELS } from '../booking/dto/interview.dto';
import { LegalService } from '../legal/legal.service';
import { ENGAGEMENTS } from '../search/search.types';
import { REPLACEMENT_REASONS } from '../replacement/dto/replacement.dto';
import { REPORT_REASONS } from '../safety/safety.dto';
import { TICKET_PRIORITIES } from '../support/dto/support.dto';

/** Language assumed when no allow-list is configured. */
const DEFAULT_LANGUAGES = ['en'];

/**
 * What the mobile apps ask for at start-up, before sign-in: the update policy, maintenance flag, legal versions and the
 * reference lists their forms need. Public, cacheable (Express adds an ETag, so `If-None-Match` answers 304) and free of personal
 * data and secrets. Categories and areas are admin data and stay on their own endpoints.
 */
class MinVersionView {
  @ApiProperty({
    nullable: true,
    type: String,
    example: '1.2.0',
    description:
      'major.minor.patch only (no +build; the build number is not enforced). null = no minimum.',
  })
  minVersion!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: 'https://play.google.com/store/apps/details?id=com.example.app',
    description: 'https store page for the Update button; null when not configured.',
  })
  storeUrl!: string | null;
}

class SupportContactView {
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
}

class PolicyContentView {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Approved cancellation policy text; null until the client supplies it.',
  })
  cancellationText!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'https link to the full cancellation policy; null when not configured.',
  })
  cancellationUrl!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Approved refund policy text; null until the client supplies it.',
  })
  refundText!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'https link to the full refund policy; null when not configured.',
  })
  refundUrl!: string | null;
}

export class AppConfigView {
  @ApiProperty({
    type: MinVersionView,
    description: 'An app older than this must force an update.',
  })
  customer!: MinVersionView;
  @ApiProperty({ type: MinVersionView }) worker!: MinVersionView;
  @ApiProperty({ description: 'true = show the maintenance screen.' }) maintenance!: boolean;
  @ApiProperty({ type: SupportContactView }) support!: SupportContactView;
  @ApiProperty({ type: LegalCurrentView }) legal!: LegalCurrentView;
  @ApiProperty({
    type: PolicyContentView,
    description:
      'Approved cancellation and refund policy, exactly as configured. Every field is null until the client supplies it; the server never writes policy text itself.',
  })
  policy!: PolicyContentView;
  @ApiProperty({ type: [String], example: ['en'] }) languages!: string[];
}

class StatusLabelsView {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  booking!: Record<string, string>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  interview!: Record<string, string>;
}

export class ReplacementReasonView {
  @ApiProperty({ example: 'WORK_QUALITY' }) code!: string;
  @ApiProperty({ example: 'Quality of work' }) label!: string;
}

export class RatingTagView {
  @ApiProperty({ example: 'PUNCTUAL' }) code!: string;
  @ApiProperty({ example: 'Punctual' }) label!: string;
  @ApiProperty({ enum: ['POSITIVE', 'NEGATIVE'] }) sentiment!: string;
}

export class ReferenceDataView {
  @ApiProperty({ type: [String] }) engagements!: string[];
  @ApiProperty({
    type: [String],
    description:
      'MONTH is the monthly budget (DEC-07): a monthly driver or cook is FULL_TIME or PART_TIME with budgetPeriod MONTH. MONTHLY is accepted on input as an alias.',
  })
  budgetPeriods!: string[];
  @ApiProperty({ type: [String] }) reportReasons!: string[];
  @ApiProperty({ type: [String] }) ticketPriorities!: string[];
  @ApiProperty({
    type: [ReplacementReasonView],
    description: 'Fixed reasons for POST /replacement-requests (reasonCode), Q-107.',
  })
  replacementReasons!: ReplacementReasonView[];
  @ApiProperty({
    example: 10,
    description:
      'Reviews are whole numbers from 1 to this value (RATING_SCALE_MAX). `rating.average` is on the same scale.',
  })
  ratingScaleMax!: number;
  @ApiProperty({
    example: 300,
    description: 'Longest review text the server accepts (RATING_REVIEW_MAX_LENGTH, default 300).',
  })
  ratingReviewMax!: number;
  @ApiProperty({
    type: [RatingTagView],
    description:
      'Fixed rating tag catalogue (Q-103, pending client confirmation). Send the `code` values in `tags` of POST /ratings; `label` is display text. Any tag is accepted with any score.',
  })
  ratingTags!: RatingTagView[];
  @ApiProperty({ type: [String] }) languages!: string[];
  @ApiProperty({ type: StatusLabelsView }) statusLabels!: StatusLabelsView;
}

@ApiTags('App')
@Controller({ version: '1' })
export class MetaController {
  constructor(
    private readonly config: AppConfigService,
    private readonly legal: LegalService,
  ) {}

  @Get('app-config')
  @ApiModelResponse(AppConfigView)
  @Public()
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'Update policy, maintenance flag, legal versions and support contact (no sign-in)',
    description:
      'An app older than `minVersion` for its kind should force an update; `maintenance: true` means show the maintenance screen.',
  })
  appConfig(): {
    customer: { minVersion: string | null; storeUrl: string | null };
    worker: { minVersion: string | null; storeUrl: string | null };
    maintenance: boolean;
    support: { phone: string | null; email: string | null };
    legal: ReturnType<LegalService['current']>;
    policy: {
      cancellationText: string | null;
      cancellationUrl: string | null;
      refundText: string | null;
      refundUrl: string | null;
    };
    languages: string[];
  } {
    const policy = this.config.appPolicy;
    const content = this.config.policyContent;
    return {
      customer: {
        minVersion: policy.minVersionCustomer ?? null,
        storeUrl: policy.storeUrlCustomer ?? null,
      },
      worker: {
        minVersion: policy.minVersionWorker ?? null,
        storeUrl: policy.storeUrlWorker ?? null,
      },
      maintenance: policy.maintenance,
      support: { phone: policy.supportPhone ?? null, email: policy.supportEmail ?? null },
      legal: this.legal.current(),
      policy: {
        cancellationText: content.cancellationText ?? null,
        cancellationUrl: content.cancellationUrl ?? null,
        refundText: content.refundText ?? null,
        refundUrl: content.refundUrl ?? null,
      },
      languages: this.languages(),
    };
  }

  @Get('reference-data')
  @ApiModelResponse(ReferenceDataView)
  @Public()
  @Header('Cache-Control', 'public, max-age=300')
  @ApiOperation({
    summary:
      'Fixed vocabularies for forms: engagement types, budget periods, report reasons, languages',
  })
  referenceData(): {
    engagements: readonly string[];
    budgetPeriods: readonly string[];
    reportReasons: readonly string[];
    ticketPriorities: readonly string[];
    replacementReasons: ReadonlyArray<{ code: string; label: string }>;
    /** Reviews are whole numbers from 1 to this value (RATING_SCALE_MAX). `rating.average` is on the same scale. */
    ratingScaleMax: number;
    /** Longest review text accepted (RATING_REVIEW_MAX_LENGTH). */
    ratingReviewMax: number;
    ratingTags: ReadonlyArray<{ code: string; label: string; sentiment: string }>;
    languages: string[];
    statusLabels: { booking: Record<string, string>; interview: Record<string, string> };
  } {
    return {
      engagements: ENGAGEMENTS,
      budgetPeriods: BUDGET_PERIODS,
      reportReasons: REPORT_REASONS,
      ticketPriorities: TICKET_PRIORITIES,
      replacementReasons: REPLACEMENT_REASONS,
      ratingScaleMax: this.config.ratingScaleMax,
      ratingReviewMax: this.config.ratingReviewMax,
      ratingTags: RATING_TAGS,
      languages: this.languages(),
      statusLabels: { booking: BOOKING_STATUS_LABELS, interview: INTERVIEW_STATUS_LABELS },
    };
  }

  private languages(): string[] {
    const configured = this.config.supportedLanguages;
    return configured.length > 0 ? configured : DEFAULT_LANGUAGES;
  }
}
