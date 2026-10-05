// Thin client for the LinkedIn Marketing API endpoints needed to report on campaigns.
//
// Docs (Microsoft Learn, LinkedIn Marketing API, version li-lms-2026-09):
//   Ad accounts by user: /linkedin/marketing/integrations/ads/account-structure/create-and-manage-account-users
//   Campaigns:           /linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns
//   Ad Analytics:        /linkedin/marketing/integrations/ads-reporting/ads-reporting
//
// Required OAuth scopes: r_ads (accounts, campaigns) and r_ads_reporting (analytics).

import { buildQuery, encodeValue, restliDateRange, restliList, type CalendarDate } from './restli.ts';
import { accountId as toAccountId, campaignId as toCampaignId, campaignUrn } from './urns.ts';

export const DEFAULT_API_VERSION = '202609';
const BASE_URL = 'https://api.linkedin.com/rest';

export type AdAccountRole =
  | 'ACCOUNT_BILLING_ADMIN'
  | 'ACCOUNT_MANAGER'
  | 'CAMPAIGN_MANAGER'
  | 'CREATIVE_MANAGER'
  | 'VIEWER';

export interface AdAccountAccess {
  /** urn:li:sponsoredAccount:{id} */
  account: string;
  user: string;
  role: AdAccountRole;
}

export type CampaignStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'COMPLETED'
  | 'CANCELED'
  | 'DRAFT'
  | 'PENDING_DELETION'
  | 'REMOVED';

export const ALL_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'COMPLETED',
  'CANCELED',
  'DRAFT',
  'PENDING_DELETION',
  'REMOVED',
];

export interface Campaign {
  id: number;
  name: string;
  /** urn:li:sponsoredAccount:{id} */
  account: string;
  campaignGroup?: string;
  status: CampaignStatus;
  type?: string;
  objectiveType?: string;
  costType?: string;
  test?: boolean;
  runSchedule?: { start?: number; end?: number };
  dailyBudget?: { amount: string; currencyCode: string };
  totalBudget?: { amount: string; currencyCode: string };
  [key: string]: unknown;
}

export type TimeGranularity = 'ALL' | 'DAILY' | 'MONTHLY' | 'YEARLY';

export interface AnalyticsElement {
  dateRange?: { start: CalendarDate; end: CalendarDate };
  pivotValues?: string[];
  [metric: string]: unknown;
}

export interface AdAnalyticsQuery {
  campaignUrns: string[];
  start: CalendarDate;
  end?: CalendarDate;
  timeGranularity: TimeGranularity;
  fields: string[];
}

export class LinkedInApiError extends Error {
  readonly status: number;
  readonly serviceErrorCode?: number;
  readonly code?: string;
  readonly url: string;

  constructor(status: number, url: string, body: unknown) {
    const details = (body && typeof body === 'object' ? body : {}) as {
      message?: string;
      serviceErrorCode?: number;
      code?: string;
    };
    super(`LinkedIn API ${status}${details.code ? ` ${details.code}` : ''}: ${details.message ?? 'request failed'}`);
    this.name = 'LinkedInApiError';
    this.status = status;
    this.serviceErrorCode = details.serviceErrorCode;
    this.code = details.code;
    this.url = url;
  }
}

export interface LinkedInAdsClientOptions {
  accessToken: string;
  /** LinkedIn-Version header, YYYYMM. Defaults to DEFAULT_API_VERSION. */
  apiVersion?: string;
  fetch?: typeof fetch;
}

export class LinkedInAdsClient {
  readonly #accessToken: string;
  readonly #apiVersion: string;
  readonly #fetch: typeof fetch;

  constructor(options: LinkedInAdsClientOptions) {
    if (!options.accessToken) throw new TypeError('accessToken is required');
    this.#accessToken = options.accessToken;
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async #get<T>(path: string, query?: string): Promise<T> {
    const url = `${BASE_URL}${path}${query ? `?${query}` : ''}`;
    const res = await this.#fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.#accessToken}`,
        'LinkedIn-Version': this.#apiVersion,
        'X-Restli-Protocol-Version': '2.0.0',
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = { message: text };
    }
    if (!res.ok) throw new LinkedInApiError(res.status, url, body);
    return body as T;
  }

  /** Ad accounts the authenticated member can access, with their role on each. */
  async listAdAccounts(): Promise<AdAccountAccess[]> {
    const res = await this.#get<{ elements?: AdAccountAccess[] }>(
      '/adAccountUsers',
      'q=authenticatedUser',
    );
    return res.elements ?? [];
  }

  /** Fetches one campaign. LinkedIn returns 404 if it does not belong to the account. */
  async getCampaign(account: string | number, campaign: string | number): Promise<Campaign> {
    return this.#get<Campaign>(
      `/adAccounts/${toAccountId(account)}/adCampaigns/${toCampaignId(campaign)}`,
    );
  }

  /** All campaigns in an ad account, following cursor-based pagination. */
  async listCampaigns(
    account: string | number,
    options: { statuses?: readonly CampaignStatus[]; pageSize?: number } = {},
  ): Promise<Campaign[]> {
    // Campaign search requires at least one criterion, so default to every status.
    const statuses = options.statuses?.length ? options.statuses : ALL_CAMPAIGN_STATUSES;
    const pageSize = options.pageSize ?? 1000;
    const campaigns: Campaign[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.#get<{
        elements?: Campaign[];
        metadata?: { nextPageToken?: string | null };
      }>(
        `/adAccounts/${toAccountId(account)}/adCampaigns`,
        buildQuery({
          q: 'search',
          search: `(status:(values:${restliList(statuses)}))`,
          sortOrder: 'DESCENDING',
          pageSize: String(pageSize),
          pageToken: pageToken === undefined ? undefined : encodeValue(pageToken),
        }),
      );
      campaigns.push(...(res.elements ?? []));
      pageToken = res.metadata?.nextPageToken ?? undefined;
    } while (pageToken);
    return campaigns;
  }

  /** Raw call to the Ad Analytics "analytics" finder, pivoted by CAMPAIGN. */
  async getCampaignAdAnalytics(query: AdAnalyticsQuery): Promise<AnalyticsElement[]> {
    const res = await this.#get<{ elements?: AnalyticsElement[] }>(
      '/adAnalytics',
      buildQuery({
        q: 'analytics',
        pivot: 'CAMPAIGN',
        timeGranularity: query.timeGranularity,
        dateRange: restliDateRange(query.start, query.end),
        campaigns: restliList(query.campaignUrns.map((urn) => campaignUrn(urn))),
        fields: query.fields.join(','),
      }),
    );
    return res.elements ?? [];
  }
}
