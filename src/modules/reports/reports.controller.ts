import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiModelResponse } from '../../common/swagger/api-responses';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../../common/audit/audit.service';
import { CurrentUser, Permissions } from '../../common/decorators/auth.decorators';
import { RequireUserType } from '../../common/decorators/user-type.decorator';
import { PermissionCode } from '../users/rbac.constants';
import type { ExportableReport } from './dto/reports.dto';
import type { AuthenticatedUser } from '../../common/decorators/auth.decorators';
import {
  ReportCatalogEntry,
  ReportExportQuery,
  ReportPagedQuery,
  ReportRangeQuery,
  ReportResponse,
  ReportSeriesQuery,
  TopRatedQuery,
} from './dto/reports.dto';
import { ReportsService } from './reports.service';

/**
 * Operational reports (PRD section 14, FR-RPT-001..012). GET only: reports can never change data. Every endpoint needs
 * `report.view`. Dates are India-calendar days, at most 366 apart.
 */
@ApiTags('Admin - Reports')
@ApiBearerAuth()
@RequireUserType('ADMIN')
@Permissions(PermissionCode.REPORT_VIEW)
@Controller({ path: 'admin/reports', version: '1' })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The available reports with the definition each one uses' })
  catalog(): readonly ReportCatalogEntry[] {
    return this.reports.catalog();
  }

  @Get('export/:report')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="report.csv"')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Any report as a CSV file',
    description:
      'report is one of the report names listed by GET /admin/reports. Period reports need from and to (India dates, at most 366 days). At most 5000 rows. Aggregates only - no personal data beyond what the on-screen report shows. Audited.',
  })
  async export(
    @Param('report') report: ExportableReport,
    @Query() q: ReportExportQuery,
    @CurrentUser() admin: AuthenticatedUser,
  ): Promise<string> {
    const { csv, rows } = await this.reports.exportCsv(report, q);
    await this.audit.record({
      action: 'report.export',
      entityType: 'report',
      actorId: admin.userId,
      metadata: { report, from: q.from ?? null, to: q.to ?? null, rows },
    });
    return csv;
  }

  @Get('new-customers')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-001 New customers per day/week/month' })
  newCustomers(@Query() q: ReportSeriesQuery): Promise<ReportResponse> {
    return this.reports.newCustomers(q);
  }

  @Get('worker-registrations')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-002 Worker registrations and verification conversion' })
  workerRegistrations(@Query() q: ReportSeriesQuery): Promise<ReportResponse> {
    return this.reports.workerRegistrations(q);
  }

  @Get('booking-funnel')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-003 Booking requests vs confirmed bookings' })
  bookingFunnel(@Query() q: ReportSeriesQuery): Promise<ReportResponse> {
    return this.reports.bookingFunnel(q);
  }

  @Get('demand-by-category')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-004 Category-wise demand' })
  demandByCategory(@Query() q: ReportRangeQuery): Promise<ReportResponse> {
    return this.reports.demandByCategory(q);
  }

  @Get('demand-by-area')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-005 Area-wise demand (paginated)' })
  demandByArea(@Query() q: ReportPagedQuery): Promise<ReportResponse> {
    return this.reports.demandByArea(q);
  }

  @Get('worker-utilization')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-006 Worker utilization (point in time)' })
  workerUtilization(): Promise<ReportResponse> {
    return this.reports.workerUtilization();
  }

  @Get('interview-conversion')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-007 Interview-to-confirmation conversion' })
  interviewConversion(@Query() q: ReportRangeQuery): Promise<ReportResponse> {
    return this.reports.interviewConversion(q);
  }

  @Get('cancellation-rate')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-008 Cancellation rate' })
  cancellationRate(@Query() q: ReportRangeQuery): Promise<ReportResponse> {
    return this.reports.cancellationRate(q);
  }

  @Get('replacement-rate')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-009 Replacement rate' })
  replacementRate(@Query() q: ReportRangeQuery): Promise<ReportResponse> {
    return this.reports.replacementRate(q);
  }

  @Get('payment-collections')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-010 Payment collections by period and fee type' })
  paymentCollections(@Query() q: ReportSeriesQuery): Promise<ReportResponse> {
    return this.reports.paymentCollections(q);
  }

  @Get('support-tickets')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-011 Support ticket volume and resolution time' })
  supportTickets(@Query() q: ReportSeriesQuery): Promise<ReportResponse> {
    return this.reports.supportTickets(q);
  }

  @Get('top-rated-workers')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-012 Top-rated workers (paginated, all-time)' })
  topRatedWorkers(@Query() q: TopRatedQuery): Promise<ReportResponse> {
    return this.reports.topRatedWorkers(q);
  }

  @Get('repeat-customers')
  @ApiModelResponse(ReportResponse)
  @ApiOperation({ summary: 'FR-RPT-012 Repeat customers (paginated)' })
  repeatCustomers(@Query() q: ReportPagedQuery): Promise<ReportResponse> {
    return this.reports.repeatCustomers(q);
  }
}
