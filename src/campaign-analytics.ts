import type { CalendarDate } from './linkedin/restli.ts';
import type {
  AnalyticsElement,
  Campaign,
  LinkedInAdsClient,
  TimeGranularity,
} from './linkedin/client.ts';
import { accountUrn, campaignUrn } from './linkedin/urns.ts';

/**
 * Metrics requested by default. adAnalytics returns only impressions and clicks
 * unless `fields` is set, and accepts at most 20 fields per request.
 */
export const DEFAULT_METRICS = [
  'impressions',
  'clicks',
  'costInLocalCurrency',
  'costInUsd',
  'landingPageClicks',
  'totalEngagements',
  'reactions',
  'comments',
  'shares',
  'follows',
  'externalWebsiteConversions',
  'oneClickLeads',
  'videoViews',
  'videoCompletions',
  'approximateMemberReach',
] as const;

export const MAX_FIELDS = 20;

/** LinkedIn only returns approximateMemberReach for ranges of 92 days or less. */
const REACH_MAX_DAYS = 92;
const NON_METRIC_FIELDS = ['dateRange', 'pivotValues'];

export interface CampaignAnalyticsOptions {
  /** Ad account ID or urn:li:sponsoredAccount URN. */
  account: string | number;
  /** Campaign ID or urn:li:sponsoredCampaign URN. */
  campaign: string | number;
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. Defaults to today (UTC). */
  end?: string;
  /** Breakdown granularity. Defaults to DAILY. */
  timeGranularity?: TimeGranularity;
  /** Metric names to request instead of DEFAULT_METRICS. */
  metrics?: readonly string[];
  /** Reference "today" used for the default end date; injectable for tests. */
  now?: Date;
}

export interface DerivedMetrics {
  /** clicks / impressions */
  ctr: number | null;
  /** costInLocalCurrency / clicks */
  cpc: number | null;
  /** costInLocalCurrency / impressions * 1000 */
  cpm: number | null;
  /** costInLocalCurrency / externalWebsiteConversions */
  costPerConversion: number | null;
}

export interface AnalyticsRow {
  start: string;
  end: string;
  metrics: Record<string, number | null>;
  derived: DerivedMetrics;
}

export interface CampaignAnalyticsReport {
  account: string;
  campaign: Pick<Campaign, 'id' | 'name' | 'status' | 'type' | 'objectiveType' | 'costType'> & {
    urn: string;
    currency?: string;
  };
  dateRange: { start: string; end: string };
  timeGranularity: TimeGranularity;
  metrics: string[];
  /** Totals for the whole range, from a single timeGranularity=ALL request. */
  summary: AnalyticsRow | null;
  /** One row per period. Equals [summary] when timeGranularity is ALL. */
  rows: AnalyticsRow[];
}

export function parseDate(input: string, label: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) throw new RangeError(`${label} must be YYYY-MM-DD, got "${input}"`);
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`${label} is not a valid calendar date: "${input}"`);
  }
  return { year, month, day };
}

function formatDate(d: CalendarDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function toUtcMs(d: CalendarDate): number {
  return Date.UTC(d.year, d.month - 1, d.day);
}

function inclusiveDays(start: CalendarDate, end: CalendarDate): number {
  return Math.round((toUtcMs(end) - toUtcMs(start)) / 86_400_000) + 1;
}

function toNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratio(numerator: number | null, denominator: number | null, scale = 1): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return (numerator / denominator) * scale;
}

function toRow(element: AnalyticsElement, metrics: readonly string[], fallback: { start: string; end: string }): AnalyticsRow {
  const values: Record<string, number | null> = {};
  for (const metric of metrics) values[metric] = toNumber(element[metric]);
  const cost = values.costInLocalCurrency ?? toNumber(element.costInLocalCurrency);
  const clicks = values.clicks ?? toNumber(element.clicks);
  const impressions = values.impressions ?? toNumber(element.impressions);
  const conversions = values.externalWebsiteConversions ?? toNumber(element.externalWebsiteConversions);
  return {
    start: element.dateRange ? formatDate(element.dateRange.start) : fallback.start,
    end: element.dateRange ? formatDate(element.dateRange.end) : fallback.end,
    metrics: values,
    derived: {
      ctr: ratio(clicks, impressions),
      cpc: ratio(cost, clicks),
      cpm: ratio(cost, impressions, 1000),
      costPerConversion: ratio(cost, conversions),
    },
  };
}

/**
 * Fetches performance analytics for one campaign in one of the user's ad accounts.
 *
 * The campaign is first loaded through its ad account, which confirms it belongs
 * to that account and that the token can read it (LinkedIn answers 403/404 otherwise).
 */
export async function fetchCampaignAnalytics(
  client: LinkedInAdsClient,
  options: CampaignAnalyticsOptions,
): Promise<CampaignAnalyticsReport> {
  const start = parseDate(options.start, 'start');
  const now = options.now ?? new Date();
  const end = options.end
    ? parseDate(options.end, 'end')
    : { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  if (toUtcMs(start) > toUtcMs(end)) {
    throw new RangeError(`start (${formatDate(start)}) must not be after end (${formatDate(end)})`);
  }
  const timeGranularity = options.timeGranularity ?? 'DAILY';

  let metrics = [...new Set(options.metrics?.length ? options.metrics : DEFAULT_METRICS)].filter(
    (m) => !NON_METRIC_FIELDS.includes(m),
  );
  if (!options.metrics?.length && inclusiveDays(start, end) > REACH_MAX_DAYS) {
    metrics = metrics.filter((m) => m !== 'approximateMemberReach');
  }
  const fields = [...NON_METRIC_FIELDS, ...metrics];
  if (fields.length > MAX_FIELDS) {
    throw new RangeError(
      `LinkedIn allows at most ${MAX_FIELDS} fields per adAnalytics request (including dateRange and pivotValues); got ${fields.length}`,
    );
  }

  const campaign = await client.getCampaign(options.account, options.campaign);
  const urn = campaignUrn(campaign.id ?? options.campaign);
  const query = { campaignUrns: [urn], start, end, fields };
  const range = { start: formatDate(start), end: formatDate(end) };

  // LinkedIn's metrics are approximate, and its docs advise requesting a full
  // period rather than summing daily rows, so totals come from their own ALL request.
  const [summaryElements, rowElements] = await Promise.all([
    client.getCampaignAdAnalytics({ ...query, timeGranularity: 'ALL' }),
    timeGranularity === 'ALL'
      ? Promise.resolve(null)
      : client.getCampaignAdAnalytics({ ...query, timeGranularity }),
  ]);

  const summary = summaryElements[0] ? toRow(summaryElements[0], metrics, range) : null;
  const rows = rowElements
    ? rowElements
        .map((el) => toRow(el, metrics, range))
        .sort((a, b) => a.start.localeCompare(b.start))
    : summary
      ? [summary]
      : [];

  return {
    account: accountUrn(campaign.account ?? options.account),
    campaign: {
      urn,
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      type: campaign.type,
      objectiveType: campaign.objectiveType,
      costType: campaign.costType,
      currency: campaign.dailyBudget?.currencyCode ?? campaign.totalBudget?.currencyCode,
    },
    dateRange: range,
    timeGranularity,
    metrics,
    summary,
    rows,
  };
}
