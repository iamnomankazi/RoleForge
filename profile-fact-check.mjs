const MONTHS = new Map([
  ['jan', 1], ['january', 1], ['feb', 2], ['february', 2], ['mar', 3], ['march', 3],
  ['apr', 4], ['april', 4], ['may', 5], ['jun', 6], ['june', 6], ['jul', 7], ['july', 7],
  ['aug', 8], ['august', 8], ['sep', 9], ['september', 9], ['oct', 10], ['october', 10],
  ['nov', 11], ['november', 11], ['dec', 12], ['december', 12],
]);
const MONTH_PATTERN = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const GRADUATION_WORDING = /\bgraduat\w*\b|\bdegree\s+(?:completion|completed|finish(?:ed|ing))\b|\b(?:completed|finishing)\s+(?:(?:my|the|a)\s+)?(?:degree|studies|program)\b|\bexpected\s+\d{4}\b/i;
const DIRECT_GRADUATION_YEAR = /(?:\bgraduat\w*|\bdegree\s+(?:completion|completed|finish(?:ed|ing))\b)\s*(?:(?:date|expected|in|by|on|around|year|is|before|after|until|through)\s*){0,4}[:,\-]?\s*$|\bexpected\s*$/i;
const DATE_PATTERN = new RegExp([
  String.raw`(?<![\p{L}\p{N}])\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])\d{1,2}[/.]\d{1,2}[/.]\d{4}(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])${MONTH_PATTERN}\.?\s+\d{4}(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])\d{1,2}/\d{4}(?![\p{L}\p{N}])`,
  String.raw`(?<![\p{L}\p{N}])\d{4}(?![\p{L}\p{N}])`,
].join('|'), 'giu');

function validDate(year, month, day = 1) {
  if (!Number.isInteger(year) || year < 1 || !Number.isInteger(month) || month < 1 || month > 12) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parsedDate(raw) {
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    return validDate(year, month, day) ? { month, year } : null;
  }
  match = raw.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (match) {
    const [, day, month, year] = match.map(Number);
    return validDate(year, month, day) ? { month, year } : null;
  }
  match = raw.match(new RegExp(`^(${MONTH_PATTERN})\\.?\\s+(\\d{4})$`, 'i'));
  if (match) {
    const month = MONTHS.get(match[1].toLowerCase());
    const year = Number(match[2]);
    return validDate(year, month) ? { month, year } : null;
  }
  match = raw.match(/^(\d{1,2})\/(\d{4})$/);
  if (match) {
    const month = Number(match[1]);
    const year = Number(match[2]);
    return validDate(year, month) ? { month, year } : null;
  }
  match = raw.match(/^(\d{4})$/);
  if (match) return { month: null, year: Number(match[1]) };
  return null;
}

function dateClauses(line) {
  const dates = [...line.matchAll(DATE_PATTERN)];
  const clauses = [];
  let start = 0;
  for (const boundary of line.matchAll(/[;(),]|[.!?](?=\s|$)|\s+-\s+|–/gu)) {
    // Periods in numeric dates and month abbreviations belong to the date.
    if (dates.some((date) => boundary.index >= date.index && boundary.index < date.index + date[0].length)) continue;
    if (/[-–]/u.test(boundary[0])) {
      const before = dates.some((date) => date.index + date[0].length <= boundary.index
        && !line.slice(date.index + date[0].length, boundary.index).trim());
      const after = dates.some((date) => date.index >= boundary.index + boundary[0].length
        && !line.slice(boundary.index + boundary[0].length, date.index).trim());
      if (!before || !after) continue;
    }
    clauses.push({ start, end: boundary.index });
    start = boundary.index + boundary[0].length;
  }
  clauses.push({ start, end: line.length });
  return clauses.map(({ start, end }) => ({
    text: line.slice(start, end),
    dates: dates.filter((date) => date.index >= start && date.index < end)
      .map((date) => ({ raw: date[0], index: date.index - start, parsed: parsedDate(date[0]) }))
      .filter((date) => date.parsed),
  }));
}

/** Finds date statements tied to graduation wording. Lines are one-based. */
export function findGraduationDates(text) {
  if (typeof text !== 'string' || !text) return [];
  const results = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    // Config keys such as expected_graduation_date use underscores; read them as words (same length, same indexes).
    const line = rawLine.replace(/_/g, ' ');
    const clauses = dateClauses(line);
    for (const [clauseIndex, clause] of clauses.entries()) {
      const previous = clauses[clauseIndex - 1];
      const followsLabel = previous && !previous.dates.length
        && /\bgraduat\w*(?:\s+date)?\s*:?\s*$|\bexpected(?:\s+graduat\w*)?(?:\s+date)?\s*:?\s*$/i.test(previous.text);
      if (!GRADUATION_WORDING.test(clause.text) && !followsLabel) continue;
      const monthDates = clause.dates.filter((date) => date.parsed.month != null);
      const selectedDates = monthDates.length
        ? monthDates
        : clause.dates.filter((date) => DIRECT_GRADUATION_YEAR.test(clause.text.slice(0, date.index))
          || (followsLabel && !clause.text.slice(0, date.index).trim()));
      results.push(...selectedDates.map(({ parsed, raw }) => ({ ...parsed, raw, line: index + 1 })));
    }
  }
  return results;
}

function profileGraduationValue(profile) {
  return profile?.graduation_date
    ?? profile?.education_details?.expected_graduation_date
    ?? profile?.expected_graduation_date;
}

function parseProfileDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return { month: value.getUTCMonth() + 1, year: value.getUTCFullYear() };
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  let match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (match) {
    const [, day, month, year] = match.map(Number);
    return validDate(year, month, day) ? { month, year } : null;
  }
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match.map(Number);
    return validDate(year, month, day) ? { month, year } : null;
  }
  return null;
}

/** Checks graduation-date statements in user files against the profile date. */
export function checkGraduationConsistency({ profile, files = [] } = {}) {
  const profileDate = parseProfileDate(profileGraduationValue(profile));
  if (!profileDate) return { profileDate: null, mismatches: [] };
  const mismatches = [];
  for (const file of files) {
    for (const found of findGraduationDates(file?.text)) {
      const different = found.month == null
        ? found.year !== profileDate.year
        : found.month !== profileDate.month || found.year !== profileDate.year;
      if (different) mismatches.push({ path: file.path, line: found.line, raw: found.raw, month: found.month, year: found.year });
    }
  }
  return { profileDate, mismatches };
}
