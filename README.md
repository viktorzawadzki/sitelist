# sitelist

Fetches performance analytics for a LinkedIn ad campaign in any ad account the
authenticated user can access. It uses the LinkedIn Marketing API (versioned
`/rest` endpoints, `LinkedIn-Version: 202609` by default).

## Requirements

- Node.js 22.18 or later. Node runs the TypeScript sources directly, and there are no runtime dependencies.
- A LinkedIn member access token with the `r_ads` and `r_ads_reporting` scopes.
  Your app also needs Advertising API access.

## CLI

```sh
export LINKEDIN_ACCESS_TOKEN=...

# 1. Which ad accounts can I access, and in what role?
node src/cli.ts accounts

# 2. Which campaigns are in that account?
node src/cli.ts campaigns 506333826 --status ACTIVE,PAUSED

# 3. Analytics for one campaign
node src/cli.ts analytics 506333826 145282384 --start 2026-09-01 --end 2026-09-30 --granularity DAILY
```

IDs can be numeric or full URNs (`urn:li:sponsoredAccount:…`, `urn:li:sponsoredCampaign:…`).

## Library

```ts
import { LinkedInAdsClient, fetchCampaignAnalytics } from './src/index.ts';

const client = new LinkedInAdsClient({ accessToken: process.env.LINKEDIN_ACCESS_TOKEN! });
const report = await fetchCampaignAnalytics(client, {
  account: '506333826',
  campaign: '145282384',
  start: '2026-09-01',
  end: '2026-09-30',          // optional, defaults to today (UTC)
  timeGranularity: 'DAILY',   // ALL | DAILY | MONTHLY | YEARLY
  metrics: ['impressions', 'clicks', 'costInLocalCurrency'], // optional
});
```

The report contains:

- `campaign`: the name, status, type, objective, cost type and currency.
- `summary`: totals for the whole range. These come from a separate
  `timeGranularity=ALL` request because LinkedIn's metrics are approximate and
  its docs advise against adding up daily rows.
- `rows`: one row per period, sorted by date.
- `derived` on every row: `ctr`, `cpc`, `cpm` and `costPerConversion`. A value
  is `null` when its denominator is 0.

## How it works

| Step | Endpoint |
| --- | --- |
| List the user's ad accounts | `GET /rest/adAccountUsers?q=authenticatedUser` |
| List campaigns (cursor pagination) | `GET /rest/adAccounts/{id}/adCampaigns?q=search` |
| Check the campaign belongs to the account | `GET /rest/adAccounts/{id}/adCampaigns/{campaignId}` |
| Analytics | `GET /rest/adAnalytics?q=analytics&pivot=CAMPAIGN&campaigns=List(…)` |

LinkedIn limits that this code enforces or works around:

- At most 20 `fields` per adAnalytics request.
- `approximateMemberReach` only works for ranges of 92 days or less. It is
  dropped from the default metrics on longer ranges.
- adAnalytics has no pagination and returns at most 15,000 rows. That is ample
  for a single campaign, even at daily granularity.

Reference: [LinkedIn Ad Analytics docs](https://learn.microsoft.com/linkedin/marketing/integrations/ads-reporting/ads-reporting).

## Development

```sh
npm install
npm test
npm run typecheck
```
