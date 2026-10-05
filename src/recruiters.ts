// Identifies recruiters among a member's 1st-degree connections.
//
// LinkedIn's Connections API (r_1st_connections) is restricted to approved
// partners, so the input is the member's own data export instead:
// Settings → Data privacy → Get a copy of your data → Connections, which
// yields Connections.csv with these columns:
//   First Name, Last Name, URL, Email Address, Company, Position, Connected On

export interface Connection {
  firstName: string;
  lastName: string;
  url: string;
  email: string;
  company: string;
  position: string;
  connectedOn: string;
}

export type RecruiterConfidence = 'high' | 'medium' | 'low';

export interface RecruiterMatch extends Connection {
  confidence: RecruiterConfidence;
  reasons: string[];
}

/** Title phrases that on their own mark someone as working in recruiting. */
const TITLE_HIGH: ReadonlyArray<[RegExp, string]> = [
  [/\brecruit(er|ers|ing|ment)\b/i, 'recruiting title'],
  [/\btalent\s+(acquisition|sourc\w*|scout|partner|hunter|attraction|advisor)\b/i, 'talent acquisition title'],
  [/\bsourc(er|ing\s+(specialist|partner|lead|manager))\b/i, 'sourcer title'],
  [/\bhead\s?-?hunt(er|ing|erin)?\b/i, 'headhunter title'],
  [/\bexecutive\s+search\b/i, 'executive search title'],
  [/\b(technical|tech|it)\s+recruit/i, 'technical recruiter title'],
  // Common non-English titles.
  [/\b(rekruter\w*|rekrutacj\w*|rekrutier\w*|recruteu?r\w*|recrutement|reclutador\w*|reclutamiento|selezione\s+del\s+personale|personalberater\w*|personalvermittl\w*|wervings?\w*|recrutador\w*)\b/i, 'recruiting title (non-English)'],
];

/** Title phrases that suggest recruiting but are often broader HR/people roles. */
const TITLE_MEDIUM: ReadonlyArray<[RegExp, string]> = [
  [/\btalent\b/i, 'talent title'],
  [/\b(hiring|staffing)\b/i, 'hiring/staffing title'],
  [/\bpeople\s+(partner|operations)\b/i, 'people team title'],
];

/** Companies whose names suggest an agency or search firm. */
const COMPANY_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/\b(recruit\w*|staffing|headhunt\w*|executive\s+search|search\s+partners|talent\s+(solutions|partners|group))\b/i, 'recruiting/staffing company'],
  [/\b(rekrutacj\w*|personalberatung|personaldienstleist\w*|reclutamiento|recrutement)\b/i, 'recruiting company (non-English)'],
];

/**
 * Builders of recruiting products ("Software Engineer, Recruiting Platform")
 * match recruiting words but are not recruiters, unless the title also names
 * an unambiguous recruiter role.
 */
const BUILDER_ROLE = /\b(engineer\w*|developer|designer|scientist|architect|product\s+manager)\b/i;
const EXPLICIT_RECRUITER = /\b(recruiters?|sourcer|head\s?-?hunter|talent\s+acquisition)\b/i;

function isBuilderOfRecruitingProduct(position: string): boolean {
  return BUILDER_ROLE.test(position) && !EXPLICIT_RECRUITER.test(position);
}

function firstMatch(text: string, rules: ReadonlyArray<[RegExp, string]>): string | undefined {
  return rules.find(([re]) => re.test(text))?.[1];
}

/** Classifies one connection, or returns null if it does not look like a recruiter. */
export function classifyRecruiter(connection: Connection): RecruiterMatch | null {
  const { position, company } = connection;
  if (isBuilderOfRecruitingProduct(position)) return null;

  const titleHigh = firstMatch(position, TITLE_HIGH);
  const titleMedium = titleHigh ? undefined : firstMatch(position, TITLE_MEDIUM);
  const companyHint = firstMatch(company, COMPANY_HINTS);

  const reasons = [titleHigh, titleMedium, companyHint].filter((r): r is string => !!r);
  if (reasons.length === 0) return null;

  let confidence: RecruiterConfidence;
  if (titleHigh) confidence = 'high';
  else if (titleMedium && companyHint) confidence = 'high';
  else if (titleMedium) confidence = 'medium';
  else confidence = 'low'; // only the employer looks like an agency

  return { ...connection, confidence, reasons };
}

const CONFIDENCE_RANK: Record<RecruiterConfidence, number> = { high: 0, medium: 1, low: 2 };

export function findRecruiters(
  connections: readonly Connection[],
  minConfidence: RecruiterConfidence = 'medium',
): RecruiterMatch[] {
  return connections
    .map(classifyRecruiter)
    .filter((m): m is RecruiterMatch => m !== null && CONFIDENCE_RANK[m.confidence] <= CONFIDENCE_RANK[minConfidence])
    .sort(
      (a, b) =>
        CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
        a.lastName.localeCompare(b.lastName) ||
        a.firstName.localeCompare(b.firstName),
    );
}

// --- CSV ---------------------------------------------------------------------

/** RFC 4180 parser: quoted fields, escaped quotes, commas and newlines in quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const HEADER_KEYS: Record<string, keyof Connection> = {
  'first name': 'firstName',
  'last name': 'lastName',
  url: 'url',
  'email address': 'email',
  company: 'company',
  position: 'position',
  'connected on': 'connectedOn',
};

/**
 * Parses LinkedIn's Connections.csv export. The export starts with a few
 * "Notes:" lines before the real header, so the header row is located by name.
 */
export function parseConnectionsCsv(text: string): Connection[] {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((r) => {
    const cells = r.map((c) => c.trim().toLowerCase());
    return cells.includes('first name') && cells.includes('position');
  });
  if (headerIndex === -1) {
    throw new Error('Not a LinkedIn Connections.csv export: no "First Name ... Position" header row found.');
  }
  const columns = rows[headerIndex]!.map((c) => HEADER_KEYS[c.trim().toLowerCase()]);
  return rows
    .slice(headerIndex + 1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const conn: Connection = {
        firstName: '',
        lastName: '',
        url: '',
        email: '',
        company: '',
        position: '',
        connectedOn: '',
      };
      columns.forEach((key, i) => {
        if (key) conn[key] = (r[i] ?? '').trim();
      });
      return conn;
    });
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(matches: readonly RecruiterMatch[]): string {
  const header = ['Confidence', 'First Name', 'Last Name', 'Position', 'Company', 'URL', 'Email Address', 'Connected On', 'Reasons'];
  const lines = matches.map((m) =>
    [m.confidence, m.firstName, m.lastName, m.position, m.company, m.url, m.email, m.connectedOn, m.reasons.join('; ')]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}
