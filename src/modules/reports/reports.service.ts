import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainException } from '../../common/errors/domain.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { skipFor } from '../../common/pagination/pagination';
import { isRealDate } from '../../common/time/india';
import {
  MAX_REPORT_RANGE_DAYS,
  ReportCatalogEntry,
  ReportPagedQuery,
  ReportRangeQuery,
  ReportResponse,
  ReportSeriesQuery,
  TopRatedQuery,
} from './dto/reports.dto';
import { REPORT_CATALOG } from './reports.catalog';
import { ReportsRepository } from './reports.repository';

const DAY_MS = 86_400_000;

/** numerator / denominator to four decimals; null when nothing happened (a rate over zero is not 0%). */
export function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 10_000;
}

/**
 * The reports of PRD section 14 (FRD section 7). Reports are read-only (the repository runs READ ONLY transactions), take a
 * bounded date range (India calendar), and always return the definition used, so the numbers cannot be misread. A metric
 * the data cannot answer is not faked: the response says so in `notes` instead.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly repository: ReportsRepository) {}

  catalog(): readonly ReportCatalogEntry[] {
    return REPORT_CATALOG;
  }

  async newCustomers(q: ReportSeriesQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const series = await this.repository.newCustomers(range, q.interval);
    return this.respond('new-customers', range, {
      interval: q.interval,
      total: series.reduce((sum, p) => sum + p.count, 0),
      series,
    });
  }

  async workerRegistrations(q: ReportSeriesQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const series = await this.repository.workerRegistrations(range, q.interval);
    const registered = series.reduce((s, p) => s + p.registered, 0);
    const verified = series.reduce((s, p) => s + p.verified, 0);
    return this.respond('worker-registrations', range, {
      interval: q.interval,
      registered,
      verified,
      verificationConversion: rate(verified, registered),
      series: series.map((p) => ({ ...p, verificationConversion: rate(p.verified, p.registered) })),
    });
  }

  async bookingFunnel(q: ReportSeriesQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const series = await this.repository.bookingFunnel(range, q.interval);
    const requests = series.reduce((s, p) => s + p.requests, 0);
    const confirmed = series.reduce((s, p) => s + p.confirmed, 0);
    return this.respond('booking-funnel', range, {
      interval: q.interval,
      requests,
      confirmed,
      confirmationRate: rate(confirmed, requests),
      series: series.map((p) => ({ ...p, confirmationRate: rate(p.confirmed, p.requests) })),
    });
  }

  async demandByCategory(q: ReportRangeQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const categories = await this.repository.demandByCategory(range);
    return this.respond('demand-by-category', range, {
      total: categories.reduce((s, c) => s + c.requests, 0),
      categories,
    });
  }

  async demandByArea(q: ReportPagedQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const { items, total } = await this.repository.demandByArea(range, skipFor(q), q.limit);
    return this.respond('demand-by-area', range, items, { page: q.page, limit: q.limit, total });
  }

  async workerUtilization(): Promise<ReportResponse> {
    const u = await this.repository.workerUtilization();
    return this.respond('worker-utilization', null, {
      ...u,
      utilization: rate(u.workersWithActiveBooking, u.verifiedWorkers),
    });
  }

  async interviewConversion(q: ReportRangeQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const c = await this.repository.interviewConversion(range);
    return this.respond('interview-conversion', range, {
      ...c,
      conversion: rate(c.confirmed, c.interviewsHeld),
    });
  }

  async cancellationRate(q: ReportRangeQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const c = await this.repository.cancellation(range);
    return this.respond('cancellation-rate', range, {
      totalBookings: c.total,
      cancelled: c.cancelled,
      cancellationRate: rate(c.cancelled, c.total),
    });
  }

  async replacementRate(q: ReportRangeQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const r = await this.repository.replacement(range);
    return this.respond('replacement-rate', range, {
      ...r,
      replacementRate: rate(r.replacementRequests, r.activeBookings),
    });
  }

  async paymentCollections(q: ReportSeriesQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const rows = await this.repository.paymentCollections(range, q.interval);
    const rowsAsNumbers = rows.map((r) => ({
      period: r.period,
      feeCode: r.feeCode,
      currency: r.currency,
      payments: r.payments,
      grossMinor: Number(r.grossMinor),
      refundedMinor: Number(r.refundedMinor),
    }));
    const totals = new Map<
      string,
      { payments: number; grossMinor: number; refundedMinor: number }
    >();
    for (const r of rowsAsNumbers) {
      const key = `${r.feeCode}|${r.currency}`;
      const t = totals.get(key) ?? { payments: 0, grossMinor: 0, refundedMinor: 0 };
      t.payments += r.payments;
      t.grossMinor += r.grossMinor;
      t.refundedMinor += r.refundedMinor;
      totals.set(key, t);
    }
    return this.respond('payment-collections', range, {
      interval: q.interval,
      totalsByFeeType: [...totals.entries()].map(([key, t]) => {
        const [feeCode, currency] = key.split('|');
        return { feeCode, currency, ...t };
      }),
      series: rowsAsNumbers,
    });
  }

  async supportTickets(q: ReportSeriesQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const s = await this.repository.supportTickets(range, q.interval);
    return this.respond('support-tickets', range, {
      interval: q.interval,
      created: s.series.reduce((sum, p) => sum + p.count, 0),
      byStatus: s.byStatus,
      closed: s.closed,
      averageResolutionSeconds: s.averageResolutionSeconds,
      series: s.series,
    });
  }

  async topRatedWorkers(q: TopRatedQuery): Promise<ReportResponse> {
    const { items, total } = await this.repository.topRatedWorkers(
      q.minRatings,
      skipFor(q),
      q.limit,
    );
    return this.respond(
      'top-rated-workers',
      null,
      items.map((w) => ({
        workerId: w.workerId,
        name: w.name,
        ratingCount: w.ratingCount,
        averageRating: Math.round((w.ratingSum / w.ratingCount) * 100) / 100,
      })),
      { page: q.page, limit: q.limit, total },
    );
  }

  async repeatCustomers(q: ReportPagedQuery): Promise<ReportResponse> {
    const range = this.range(q);
    const { items, total } = await this.repository.repeatCustomers(range, skipFor(q), q.limit);
    return this.respond('repeat-customers', range, items, {
      page: q.page,
      limit: q.limit,
      total,
    });
  }

  // --- internals ---------------------------------------------------------------------------------------------

  /** Real calendar dates, from <= to, at most MAX_REPORT_RANGE_DAYS days. */
  private range(q: ReportRangeQuery): { from: string; to: string } {
    const problems: Array<{ field: string; messages: string[] }> = [];
    for (const field of ['from', 'to'] as const) {
      if (!isRealDate(q[field])) {
        problems.push({ field, messages: [`${field} must be a real calendar date`] });
      }
    }
    if (problems.length === 0) {
      const days =
        (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / DAY_MS + 1;
      if (days < 1) {
        problems.push({ field: 'to', messages: ['to must not be before from'] });
      } else if (days > MAX_REPORT_RANGE_DAYS) {
        problems.push({
          field: 'to',
          messages: [`the range must not exceed ${MAX_REPORT_RANGE_DAYS} days`],
        });
      }
    }
    if (problems.length > 0) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED,
        'Request validation failed',
        HttpStatus.BAD_REQUEST,
        problems,
      );
    }
    return { from: q.from, to: q.to };
  }

  private respond(
    name: string,
    range: { from: string; to: string } | null,
    data: unknown,
    meta?: { page: number; limit: number; total: number },
  ): ReportResponse {
    const entry = REPORT_CATALOG.find((r) => r.report === name)!;
    return {
      report: name,
      definition: entry.definition,
      notes: [...entry.notes],
      from: range?.from ?? null,
      to: range?.to ?? null,
      data,
      ...(meta ? { meta } : {}),
    };
  }
}
