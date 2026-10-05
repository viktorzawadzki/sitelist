const ACCOUNT_PREFIX = 'urn:li:sponsoredAccount:';
const CAMPAIGN_PREFIX = 'urn:li:sponsoredCampaign:';

function toId(input: string | number, prefix: string, label: string): string {
  const raw = String(input).trim();
  const id = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  if (!/^\d+$/.test(id)) {
    throw new TypeError(`Invalid ${label}: "${input}". Expected a numeric ID or ${prefix}{id}.`);
  }
  return id;
}

/** Accepts `123` or `urn:li:sponsoredAccount:123` and returns `123`. */
export function accountId(input: string | number): string {
  return toId(input, ACCOUNT_PREFIX, 'ad account');
}

/** Accepts `456` or `urn:li:sponsoredCampaign:456` and returns `456`. */
export function campaignId(input: string | number): string {
  return toId(input, CAMPAIGN_PREFIX, 'campaign');
}

export function accountUrn(input: string | number): string {
  return ACCOUNT_PREFIX + accountId(input);
}

export function campaignUrn(input: string | number): string {
  return CAMPAIGN_PREFIX + campaignId(input);
}
