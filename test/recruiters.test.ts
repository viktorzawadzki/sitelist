import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRecruiter,
  findRecruiters,
  parseConnectionsCsv,
  parseCsv,
  toCsv,
  type Connection,
} from '../src/recruiters.ts';

// Shape of LinkedIn's Connections.csv export, including its preamble.
const EXPORT = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Anna,Nowak,https://www.linkedin.com/in/annanowak,,Acme Corp,Senior Technical Recruiter,12 Mar 2024
Ben,Ortiz,https://www.linkedin.com/in/benortiz,ben@example.com,Globex,"Talent Acquisition Partner, EMEA",01 Feb 2023
Cara,Lee,https://www.linkedin.com/in/caralee,,Initech,Software Engineer,05 Jan 2022
Dan,Kim,https://www.linkedin.com/in/dankim,,Hays Recruitment,Account Director,20 Jul 2021
Eve,Moreau,https://www.linkedin.com/in/evemoreau,,Talentsoft,Head of Talent,14 Sep 2020
Finn,Weber,https://www.linkedin.com/in/finnweber,,Kienbaum,Personalberater,03 Mar 2019
Gus,Hall,https://www.linkedin.com/in/gushall,,Greenhouse,"Software Engineer, Recruiting Platform",22 Apr 2024
Hana,Sato,https://www.linkedin.com/in/hanasato,,Michael Page Staffing,Talent Manager,09 Oct 2023
`;

const conn = (position: string, company = 'Acme'): Connection => ({
  firstName: 'X',
  lastName: 'Y',
  url: '',
  email: '',
  company,
  position,
  connectedOn: '',
});

test('parseConnectionsCsv skips the export preamble and maps columns', () => {
  const rows = parseConnectionsCsv(EXPORT);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[1], {
    firstName: 'Ben',
    lastName: 'Ortiz',
    url: 'https://www.linkedin.com/in/benortiz',
    email: 'ben@example.com',
    company: 'Globex',
    position: 'Talent Acquisition Partner, EMEA',
    connectedOn: '01 Feb 2023',
  });
});

test('parseConnectionsCsv rejects files that are not the export', () => {
  assert.throws(() => parseConnectionsCsv('a,b,c\n1,2,3\n'), /Connections\.csv/);
});

test('parseCsv handles quotes, escaped quotes, CRLF and BOM', () => {
  assert.deepEqual(parseCsv('﻿a,"b, ""c"""\r\n1,"multi\nline"'), [
    ['a', 'b, "c"'],
    ['1', 'multi\nline'],
  ]);
});

test('classifyRecruiter confidence levels', () => {
  assert.equal(classifyRecruiter(conn('Senior Technical Recruiter'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Talent Acquisition Lead'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Sourcer'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Executive Search Consultant'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Starszy Rekruter IT'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Personalberater'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Head of Talent'))?.confidence, 'medium');
  assert.equal(classifyRecruiter(conn('Talent Manager', 'Michael Page Staffing'))?.confidence, 'high');
  assert.equal(classifyRecruiter(conn('Account Director', 'Hays Recruitment'))?.confidence, 'low');
});

test('classifyRecruiter ignores non-recruiters, including people building recruiting software', () => {
  assert.equal(classifyRecruiter(conn('Software Engineer')), null);
  assert.equal(classifyRecruiter(conn('Software Engineer, Recruiting Platform', 'Greenhouse')), null);
  assert.equal(classifyRecruiter(conn('Product Manager, Hiring Tools')), null);
  assert.equal(classifyRecruiter(conn('CFO')), null);
  // An engineering recruiter is still a recruiter.
  assert.equal(classifyRecruiter(conn('Engineering Recruiter'))?.confidence, 'high');
});

test('findRecruiters filters by minimum confidence and sorts', () => {
  const connections = parseConnectionsCsv(EXPORT);
  const medium = findRecruiters(connections);
  assert.deepEqual(
    medium.map((m) => [m.firstName, m.confidence]),
    [
      ['Anna', 'high'], // sorted by last name: Nowak, Ortiz, Sato, Weber
      ['Ben', 'high'],
      ['Hana', 'high'],
      ['Finn', 'high'],
      ['Eve', 'medium'],
    ],
  );
  assert.equal(findRecruiters(connections, 'high').length, 4);
  assert.ok(findRecruiters(connections, 'low').some((m) => m.firstName === 'Dan'));
});

test('toCsv escapes fields', () => {
  const [ben] = findRecruiters(parseConnectionsCsv(EXPORT)).filter((m) => m.firstName === 'Ben');
  const out = toCsv([ben!]);
  assert.ok(out.startsWith('Confidence,First Name,Last Name,Position,'));
  assert.ok(out.includes('"Talent Acquisition Partner, EMEA"'));
});
