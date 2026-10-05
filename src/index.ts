export {
  LinkedInAdsClient,
  LinkedInApiError,
  DEFAULT_API_VERSION,
  ALL_CAMPAIGN_STATUSES,
  type AdAccountAccess,
  type Campaign,
  type CampaignStatus,
  type TimeGranularity,
} from './linkedin/client.ts';
export {
  fetchCampaignAnalytics,
  DEFAULT_METRICS,
  MAX_FIELDS,
  type CampaignAnalyticsOptions,
  type CampaignAnalyticsReport,
  type AnalyticsRow,
} from './campaign-analytics.ts';
export { accountUrn, campaignUrn } from './linkedin/urns.ts';
