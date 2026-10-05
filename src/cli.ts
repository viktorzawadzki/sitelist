#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  LinkedInAdsClient,
  LinkedInApiError,
  type CampaignStatus,
  type TimeGranularity,
} from './linkedin/client.ts';
import { fetchCampaignAnalytics } from './campaign-analytics.ts';
import { findRecruiters, parseConnectionsCsv, toCsv, type RecruiterConfidence } from './recruiters.ts';
import { readFile } from 'node:fs/promises';

const USAGE = `Usage: linkedin-analytics <command> [options]

Commands:
  accounts                              List ad accounts you can access
  campaigns <accountId> [--status S,..] List campaigns in an ad account
  analytics <accountId> <campaignId>    Fetch analytics for a campaign
      --start YYYY-MM-DD   (required) inclusive start date
      --end YYYY-MM-DD     inclusive end date (default: today, UTC)
      --granularity G      ALL | DAILY | MONTHLY | YEARLY (default: DAILY)
      --metrics a,b,c      metrics to request (default: a standard set)
  recruiters <Connections.csv>          Find recruiters among your connections
      --min-confidence C   high | medium | low (default: medium)
      --format F           json | csv (default: json)
      Export the file from LinkedIn: Settings > Data privacy >
      Get a copy of your data > Connections. No token needed.

Environment:
  LINKEDIN_ACCESS_TOKEN  OAuth token with r_ads and r_ads_reporting scopes
                         (required for accounts, campaigns, analytics)
  LINKEDIN_API_VERSION   LinkedIn-Version header, YYYYMM (optional)

Output is written to stdout.`;

const CONFIDENCES: readonly RecruiterConfidence[] = ['high', 'medium', 'low'];
const GRANULARITIES: readonly TimeGranularity[] = ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'];

function csv(value: string | undefined): string[] | undefined {
  return value?.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      start: { type: 'string' },
      end: { type: 'string' },
      granularity: { type: 'string' },
      metrics: { type: 'string' },
      status: { type: 'string' },
      'min-confidence': { type: 'string' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command || values.help ? 0 : 1;
  }

  if (command === 'recruiters') {
    if (!args[0]) throw new UsageError('recruiters requires <Connections.csv>');
    const min = (values['min-confidence'] ?? 'medium').toLowerCase() as RecruiterConfidence;
    if (!CONFIDENCES.includes(min)) throw new UsageError(`--min-confidence must be one of ${CONFIDENCES.join(', ')}`);
    const format = (values.format ?? 'json').toLowerCase();
    if (format !== 'json' && format !== 'csv') throw new UsageError('--format must be json or csv');
    const connections = parseConnectionsCsv(await readFile(args[0], 'utf8'));
    const matches = findRecruiters(connections, min);
    process.stdout.write(format === 'csv' ? toCsv(matches) : JSON.stringify(matches, null, 2) + '\n');
    console.error(`${matches.length} recruiter(s) found among ${connections.length} connection(s).`);
    return 0;
  }

  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('LINKEDIN_ACCESS_TOKEN is not set.');
    return 1;
  }
  const client = new LinkedInAdsClient({
    accessToken,
    apiVersion: process.env.LINKEDIN_API_VERSION || undefined,
  });

  let result: unknown;
  switch (command) {
    case 'accounts':
      result = await client.listAdAccounts();
      break;
    case 'campaigns': {
      if (!args[0]) throw new UsageError('campaigns requires <accountId>');
      result = await client.listCampaigns(args[0], {
        statuses: csv(values.status)?.map((s) => s.toUpperCase() as CampaignStatus),
      });
      break;
    }
    case 'analytics': {
      if (!args[0] || !args[1]) throw new UsageError('analytics requires <accountId> <campaignId>');
      if (!values.start) throw new UsageError('analytics requires --start YYYY-MM-DD');
      const granularity = values.granularity?.toUpperCase() as TimeGranularity | undefined;
      if (granularity && !GRANULARITIES.includes(granularity)) {
        throw new UsageError(`--granularity must be one of ${GRANULARITIES.join(', ')}`);
      }
      result = await fetchCampaignAnalytics(client, {
        account: args[0],
        campaign: args[1],
        start: values.start,
        end: values.end,
        timeGranularity: granularity,
        metrics: csv(values.metrics),
      });
      break;
    }
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
    } else if (err instanceof LinkedInApiError) {
      console.error(err.message);
      if (err.status === 401) console.error('Check that LINKEDIN_ACCESS_TOKEN is valid and not expired.');
      if (err.status === 403) console.error('The token needs r_ads / r_ads_reporting and access to this ad account.');
      if (err.status === 404) console.error('Campaign not found in this ad account.');
    } else {
      console.error(err instanceof Error ? err.message : err);
    }
    process.exit(1);
  },
);
