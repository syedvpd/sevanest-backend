import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/auth.decorators';
import { AppConfigService } from '../../config/app-config.service';
import { BUDGET_PERIODS } from '../booking/dto/booking.dto';
import { LegalService } from '../legal/legal.service';
import { ENGAGEMENTS } from '../search/search.types';
import { REPORT_REASONS } from '../safety/safety.dto';
import { TICKET_PRIORITIES } from '../support/dto/support.dto';

/** Language assumed when no allow-list is configured. */
const DEFAULT_LANGUAGES = ['en'];

/**
 * What the mobile apps ask for at start-up, before sign-in: the update policy, maintenance flag, legal versions and the
 * reference lists their forms need. Public, cacheable (Express adds an ETag, so `If-None-Match` answers 304) and free of personal
 * data and secrets. Categories and areas are admin data and stay on their own endpoints.
 */
@ApiTags('App')
@Controller({ version: '1' })
export class MetaController {
  constructor(
    private readonly config: AppConfigService,
    private readonly legal: LegalService,
  ) {}

  @Get('app-config')
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
    languages: string[];
  } {
    return {
      engagements: ENGAGEMENTS,
      budgetPeriods: BUDGET_PERIODS,
      reportReasons: REPORT_REASONS,
      ticketPriorities: TICKET_PRIORITIES,
      languages: this.languages(),
    };
  }

  private languages(): string[] {
    const configured = this.config.supportedLanguages;
    return configured.length > 0 ? configured : DEFAULT_LANGUAGES;
  }
}
