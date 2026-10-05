// Helpers for building Rest.li 2.0 query strings.
//
// LinkedIn's versioned Marketing APIs (https://api.linkedin.com/rest/...) require
// `X-Restli-Protocol-Version: 2.0.0`. In that protocol, the structural characters
// `(`, `)`, `,` and `:` must stay literal, while the values inside (URNs etc.)
// are percent-encoded, e.g. `campaigns=List(urn%3Ali%3AsponsoredCampaign%3A123)`.
// URLSearchParams would encode the structural characters too, so queries are
// assembled by hand here.

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export function encodeValue(value: string | number): string {
  return encodeURIComponent(String(value));
}

export function restliList(values: ReadonlyArray<string | number>): string {
  return `List(${values.map(encodeValue).join(',')})`;
}

function restliDate(d: CalendarDate): string {
  return `(year:${d.year},month:${d.month},day:${d.day})`;
}

export function restliDateRange(start: CalendarDate, end?: CalendarDate): string {
  return end
    ? `(start:${restliDate(start)},end:${restliDate(end)})`
    : `(start:${restliDate(start)})`;
}

/** Joins already-encoded `key=value` pairs, skipping undefined values. */
export function buildQuery(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}
