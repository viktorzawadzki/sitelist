import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkedInAdsClient, LinkedInApiError } from '../src/linkedin/client.ts';
import { fetchCampaignAnalytics } from '../src/campaign-analytics.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Fake fetch that routes by URL substring and records every call. */
function mockFetch(routes: Array<[match: string, status: number, body: unknown]>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const route = routes.find(([match]) => url.includes(match));
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(route[2]), { status: route[1] });
  }) as typeof fetch;
  return { fn, calls };
}

const CAMPAIGN = {
  id: 145282384,
  name: 'Q4 Lead Gen',
  account: 'urn:li:sponsoredAccount:506333826',
  status: 'ACTIVE',
  type: 'SPONSORED_UPDATES',
  objectiveType: 'LEAD_GENERATION',
  costType: 'CPC',
  dailyBudget: { amount: '50', currencyCode: 'EUR' },
};

test('listAdAccounts sends versioned Rest.li headers', async () => {
  const { fn, calls } = mockFetch([
    ['/adAccountUsers', 200, { elements: [{ account: 'urn:li:sponsoredAccount:1', user: 'urn:li:person:x', role: 'VIEWER' }] }],
  ]);
  const client = new LinkedInAdsClient({ accessToken: 'tok', fetch: fn });
  const accounts = await client.listAdAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(calls[0]!.url, 'https://api.linkedin.com/rest/adAccountUsers?q=authenticatedUser');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0]!.headers['LinkedIn-Version'], '202609');
  assert.equal(calls[0]!.headers['X-Restli-Protocol-Version'], '2.0.0');
});

test('listCampaigns follows nextPageToken', async () => {
  let page = 0;
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    page++;
    const body =
      page === 1
        ? { elements: [{ id: 1 }], metadata: { nextPageToken: 'abc/+=' } }
        : { elements: [{ id: 2 }], metadata: {} };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  const campaigns = await client.listCampaigns('urn:li:sponsoredAccount:42', { statuses: ['ACTIVE', 'PAUSED'] });
  assert.deepEqual(campaigns.map((c) => c.id), [1, 2]);
  assert.match(calls[0]!, /\/adAccounts\/42\/adCampaigns\?q=search&search=\(status:\(values:List\(ACTIVE,PAUSED\)\)\)/);
  assert.ok(!calls[0]!.includes('pageToken='));
  assert.ok(calls[1]!.endsWith('pageToken=abc%2F%2B%3D'));
});

test('fetchCampaignAnalytics builds the adAnalytics request and derives metrics', async () => {
  const { fn, calls } = mockFetch([
    ['/adCampaigns/145282384', 200, CAMPAIGN],
    [
      'timeGranularity=ALL',
      200,
      {
        elements: [
          {
            dateRange: { start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 2 } },
            pivotValues: ['urn:li:sponsoredCampaign:145282384'],
            impressions: 2000,
            clicks: 40,
            costInLocalCurrency: '80.0',
            externalWebsiteConversions: 4,
          },
        ],
      },
    ],
    [
      'timeGranularity=DAILY',
      200,
      {
        elements: [
          {
            dateRange: { start: { year: 2026, month: 9, day: 2 }, end: { year: 2026, month: 9, day: 2 } },
            impressions: 1000,
            clicks: 0,
            costInLocalCurrency: '30.0',
          },
          {
            dateRange: { start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 1 } },
            impressions: 1000,
            clicks: 40,
            costInLocalCurrency: '50.0',
          },
        ],
      },
    ],
  ]);
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  const report = await fetchCampaignAnalytics(client, {
    account: '506333826',
    campaign: 'urn:li:sponsoredCampaign:145282384',
    start: '2026-09-01',
    end: '2026-09-02',
  });

  assert.equal(calls[0]!.url, 'https://api.linkedin.com/rest/adAccounts/506333826/adCampaigns/145282384');
  const analyticsUrl = calls.find((c) => c.url.includes('timeGranularity=DAILY'))!.url;
  assert.ok(analyticsUrl.startsWith('https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=CAMPAIGN&'));
  assert.ok(analyticsUrl.includes('dateRange=(start:(year:2026,month:9,day:1),end:(year:2026,month:9,day:2))'));
  assert.ok(analyticsUrl.includes('campaigns=List(urn%3Ali%3AsponsoredCampaign%3A145282384)'));
  assert.ok(analyticsUrl.includes('fields=dateRange,pivotValues,impressions,clicks,'));
  assert.ok(analyticsUrl.includes('approximateMemberReach'), 'reach requested for short ranges');

  assert.equal(report.campaign.name, 'Q4 Lead Gen');
  assert.equal(report.campaign.currency, 'EUR');
  assert.equal(report.account, 'urn:li:sponsoredAccount:506333826');
  assert.deepEqual(report.summary?.metrics.impressions, 2000);
  assert.equal(report.summary?.derived.ctr, 0.02);
  assert.equal(report.summary?.derived.cpc, 2);
  assert.equal(report.summary?.derived.cpm, 40);
  assert.equal(report.summary?.derived.costPerConversion, 20);
  assert.deepEqual(report.rows.map((r) => r.start), ['2026-09-01', '2026-09-02'], 'rows sorted by date');
  assert.equal(report.rows[1]!.derived.cpc, null, 'no division by zero clicks');
});

test('ALL granularity makes a single analytics request; long ranges drop reach', async () => {
  const { fn, calls } = mockFetch([
    ['/adCampaigns/', 200, CAMPAIGN],
    ['/adAnalytics', 200, { elements: [] }],
  ]);
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  const report = await fetchCampaignAnalytics(client, {
    account: 506333826,
    campaign: 145282384,
    start: '2026-01-01',
    end: '2026-06-30',
    timeGranularity: 'ALL',
  });
  const analyticsCalls = calls.filter((c) => c.url.includes('/adAnalytics'));
  assert.equal(analyticsCalls.length, 1);
  assert.ok(!analyticsCalls[0]!.url.includes('approximateMemberReach'));
  assert.equal(report.summary, null);
  assert.deepEqual(report.rows, []);
});

test('end defaults to today (UTC)', async () => {
  const { fn, calls } = mockFetch([
    ['/adCampaigns/', 200, CAMPAIGN],
    ['/adAnalytics', 200, { elements: [] }],
  ]);
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  const report = await fetchCampaignAnalytics(client, {
    account: 1,
    campaign: 2,
    start: '2026-10-01',
    timeGranularity: 'ALL',
    now: new Date('2026-10-05T23:30:00Z'),
  });
  assert.deepEqual(report.dateRange, { start: '2026-10-01', end: '2026-10-05' });
  assert.ok(calls[1]!.url.includes('end:(year:2026,month:10,day:5)'));
});

test('validates input before calling LinkedIn', async () => {
  const { fn, calls } = mockFetch([]);
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  const base = { account: 1, campaign: 2 };
  await assert.rejects(fetchCampaignAnalytics(client, { ...base, start: '2026-09-31' }), /valid calendar date/);
  await assert.rejects(fetchCampaignAnalytics(client, { ...base, start: '09/01/2026' }), /YYYY-MM-DD/);
  await assert.rejects(
    fetchCampaignAnalytics(client, { ...base, start: '2026-09-02', end: '2026-09-01' }),
    /must not be after/,
  );
  await assert.rejects(
    fetchCampaignAnalytics(client, { ...base, start: '2026-09-01', metrics: Array.from({ length: 19 }, (_, i) => `m${i}`) }),
    /at most 20 fields/,
  );
  await assert.rejects(
    fetchCampaignAnalytics(client, { account: 'abc', campaign: 2, start: '2026-09-01' }),
    /Invalid ad account/,
  );
  assert.equal(calls.length, 0);
});

test('surfaces LinkedIn errors, e.g. campaign not in account', async () => {
  const { fn } = mockFetch([
    ['/adCampaigns/', 404, { status: 404, code: 'NOT_FOUND', message: 'Not found' }],
  ]);
  const client = new LinkedInAdsClient({ accessToken: 't', fetch: fn });
  await assert.rejects(
    fetchCampaignAnalytics(client, { account: 1, campaign: 2, start: '2026-09-01' }),
    (err: unknown) => err instanceof LinkedInApiError && err.status === 404 && err.code === 'NOT_FOUND',
  );
});
