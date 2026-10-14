import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ApiModelResponse } from '../../common/swagger/api-responses';
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
  @ApiProperty({ nullable: true, type: String, example: '1.2.0' }) minVersion!: string | null;
}

class SupportContactView {
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
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

export class ReferenceDataView {
  @ApiProperty({ type: [String] }) engagements!: string[];
  @ApiProperty({ type: [String] }) budgetPeriods!: string[];
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
    description:
      'Longest review text the server accepts (RATING_REVIEW_MAX_LENGTH, default 300). Rating tags are not part of V1: no tag catalogue is defined (Q-103), so none is returned or accepted.',
  })
  ratingReviewMax!: number;
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
    customer: { minVersion: string | null };
    worker: { minVersion: string | null };
    maintenance: boolean;
    support: { phone: string | null; email: string | null };
    legal: ReturnType<LegalService['current']>;
    languages: string[];
  } {
    const policy = this.config.appPolicy;
    return {
      customer: { minVersion: policy.minVersionCustomer ?? null },
      worker: { minVersion: policy.minVersionWorker ?? null },
      maintenance: policy.maintenance,
      support: { phone: policy.supportPhone ?? null, email: policy.supportEmail ?? null },
      legal: this.legal.current(),
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
      languages: this.languages(),
      statusLabels: { booking: BOOKING_STATUS_LABELS, interview: INTERVIEW_STATUS_LABELS },
    };
  }

  private languages(): string[] {
    const configured = this.config.supportedLanguages;
    return configured.length > 0 ? configured : DEFAULT_LANGUAGES;
  }
}
