#!/usr/bin/env node
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

import {
  buildContentFilter,
  buildLocationFilter,
  buildTitleFilter,
  matchedTitleKeywords,
} from './scan.mjs';
import { normalizeExperiencePolicy } from './experience-policy.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REJECT_SAMPLE_LIMIT_PER_STAGE = 50;
const FINLAND_LOCATION_TERMS = ['Finland', 'Suomi', 'Helsinki', 'Espoo', 'Vantaa', 'Tampere', 'Oulu', 'Turku'];
const FINLAND_LOCATION_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${FINLAND_LOCATION_TERMS.map(escapeRegex).join('|')})(?=$|[^\\p{L}\\p{N}])`,
  'iu',
);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usage() {
  return [
    'Usage: node filter-replay.mjs <raw-rows.jsonl[.gz]> [options]',
    '',
    'Options:',
    '  --portals <path>  Portals YAML (default: portals.yml in the repo root)',
    '  --limit <n>       Process at most n rows after country selection',
    '  --country <code>  Process one country (two-letter ISO code)',
    '  --out <dir>       Output directory (default: output/filter-replay/<timestamp>)',
    '  --help            Show this help',
  ].join('\n');
}

function parseArgs(args) {
  const options = { portals: path.join(ROOT, 'portals.yml'), limit: null, country: null, out: null, input: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) {
      if (options.input) throw new Error(`Unexpected argument: ${arg}`);
      options.input = arg;
      continue;
    }

    const [flag, inlineValue] = arg.split(/=(.*)/s, 2);
    if (!['--portals', '--limit', '--country', '--out'].includes(flag)) {
      throw new Error(`Unknown option: ${flag}`);
    }
    const value = inlineValue ?? args[++index];
    if (value == null || value === '' || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--portals') options.portals = path.resolve(value);
    else if (flag === '--out') options.out = path.resolve(value);
    else if (flag === '--country') {
      if (!/^[a-z]{2}$/i.test(value)) throw new Error('--country requires a two-letter country code');
      options.country = value.toLowerCase();
    } else {
      const limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit requires a positive integer');
      options.limit = limit;
    }
  }
  if (!options.input) throw new Error('A raw rows JSONL input path is required');
  options.input = path.resolve(options.input);
  return options;
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryNameEntries = [];
for (let first = 97; first <= 122; first += 1) {
  for (let second = 97; second <= 122; second += 1) {
    const code = String.fromCharCode(first, second);
    const name = regionNames.of(code.toUpperCase());
    if (name && name.toLowerCase() !== code) countryNameEntries.push([name.toLowerCase(), code]);
  }
}
countryNameEntries.sort((left, right) => right[0].length - left[0].length);
const countryNameToCode = new Map(countryNameEntries);
countryNameToCode.set('united kingdom', 'gb');
const countryLocationPattern = new RegExp(
  `(^|[^\\p{L}])(${countryNameEntries.map(([name]) => escapeRegex(name)).join('|')})(?=$|[^\\p{L}])`,
  'iu',
);
const LOCATION_COUNTRY_CODES = new Map([
  ['USA', 'us'], ['U.S.A.', 'us'], ['US', 'us'], ['U.S.', 'us'],
  ['UK', 'gb'], ['U.K.', 'gb'], ['FI', 'fi'], ['DE', 'de'], ['DK', 'dk'], ['NL', 'nl'],
]);
const locationCountryCodePattern = /(?:^|[,;(/\s-])\s*(USA|U\.S\.A\.|US|U\.S\.|UK|U\.K\.|FI|DE|DK|NL)(?=$|[\s,;)/-])/i;

const LOCATION_COUNTRY_ALIASES = new Map([
  ['suomi', 'fi'], ['helsinki', 'fi'], ['espoo', 'fi'], ['vantaa', 'fi'], ['tampere', 'fi'],
  ['oulu', 'fi'], ['turku', 'fi'], ['joensuu', 'fi'],
  ['berlin', 'de'], ['munich', 'de'], ['münchen', 'de'], ['hamburg', 'de'],
  ['frankfurt', 'de'], ['cologne', 'de'], ['köln', 'de'], ['düsseldorf', 'de'],
  ['amsterdam', 'nl'], ['rotterdam', 'nl'], ['the hague', 'nl'], ['eindhoven', 'nl'],
  ['copenhagen', 'dk'], ['aarhus', 'dk'], ['odense', 'dk'],
  ['new york', 'us'], ['new york city', 'us'], ['boston', 'us'], ['san francisco', 'us'],
  ['los angeles', 'us'], ['chicago', 'us'], ['seattle', 'us'], ['austin', 'us'],
  ['london', 'gb'], ['dublin', 'ie'], ['paris', 'fr'], ['zurich', 'ch'], ['stockholm', 'se'],
]);
const locationAliasPattern = new RegExp(
  `(^|[^\\p{L}])(${[...LOCATION_COUNTRY_ALIASES.keys()].sort((left, right) => right.length - left.length).map(escapeRegex).join('|')})(?=$|[^\\p{L}])`,
  'iu',
);

function normalizeCountry(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().toLowerCase();
  if (text === 'usa' || text === 'u.s.' || text === 'u.s.a.') return 'us';
  if (text === 'uk' || text === 'u.k.') return 'gb';
  if (/^[a-z]{2}$/.test(text)) return text;
  return countryNameToCode.get(text) || null;
}

function countryForRow(row) {
  const location = typeof row?.location === 'string' ? row.location.toLowerCase() : '';
  if (FINLAND_LOCATION_RE.test(location)) return 'fi';
  for (const key of ['countryCode', 'country_code', 'country_code_iso2', 'country']) {
    const explicit = normalizeCountry(row?.[key]);
    if (explicit) return explicit;
  }
  const countryMatch = countryLocationPattern.exec(location);
  if (countryMatch) return countryNameToCode.get(countryMatch[2].toLowerCase()) || 'unknown';
  const locationCodeMatch = locationCountryCodePattern.exec(typeof row?.location === 'string' ? row.location : '');
  if (locationCodeMatch) return LOCATION_COUNTRY_CODES.get(locationCodeMatch[1].toUpperCase()) || 'unknown';
  const aliasMatch = locationAliasPattern.exec(location);
  if (aliasMatch) return LOCATION_COUNTRY_ALIASES.get(aliasMatch[2].toLowerCase()) || 'unknown';
  return 'unknown';
}

function counts() {
  return { total: 0, title_rejected: 0, location_rejected: 0, content_rejected: 0, kept: 0 };
}

function jsonStructure(text) {
  let inString = false;
  let escaped = false;
  let depth = 0;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
  }
  return { inString, depth };
}

function increment(bucket, stage) {
  bucket.total += 1;
  bucket[stage] += 1;
}

function makeOutputDirectory() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(ROOT, 'output', 'filter-replay', timestamp);
}

async function writeLine(stream, value) {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, 'drain');
}

async function replay(options) {
  const config = yaml.load(await readFile(options.portals, 'utf8')) || {};
  const titleFilter = buildTitleFilter(config.title_filter);
  const locationFilter = buildLocationFilter(config.location_filter);
  const contentFilter = buildContentFilter(config.content_filter, {
    experiencePolicy: normalizeExperiencePolicy(config.experience_policy),
  });

  const outputDirectory = options.out || makeOutputDirectory();
  mkdirSync(outputDirectory, { recursive: true });
  const keptStream = createWriteStream(path.join(outputDirectory, 'kept.jsonl'), { encoding: 'utf8' });
  const rejectedStream = createWriteStream(path.join(outputDirectory, 'rejected-samples.jsonl'), { encoding: 'utf8' });
  const finlandStream = createWriteStream(path.join(outputDirectory, 'finland-examples.jsonl'), { encoding: 'utf8' });
  const overall = counts();
  const byCountry = new Map();
  const byProvider = new Map();
  const byCountryProvider = new Map();
  const rejectedSampleCounts = { title_rejected: 0, location_rejected: 0, content_rejected: 0 };
  let rowsSeen = 0;
  let sourceRecords = 0;
  let providerRowsRecords = 0;
  let ignoredRecords = 0;
  let limitReached = false;
  const started = performance.now();

  try {
    const fileStream = createReadStream(options.input);
    const inputStream = options.input.toLowerCase().endsWith('.gz') ? fileStream.pipe(createGunzip()) : fileStream;
    const lines = createInterface({ input: inputStream, crlfDelay: Infinity });
    let pendingRecord = '';
    for await (const line of lines) {
      if (!pendingRecord && !line.trim()) continue;
      const candidate = pendingRecord
        ? `${pendingRecord}${jsonStructure(pendingRecord).inString ? '\\n' : '\n'}${line}`
        : line;
      let record;
      try {
        record = JSON.parse(candidate);
      } catch (error) {
        pendingRecord = candidate;
        const state = jsonStructure(candidate);
        if (!state.inString && state.depth <= 0) {
          throw new Error(`Invalid JSON on input record ${sourceRecords + 1}: ${error.message}`);
        }
        continue;
      }
      pendingRecord = '';
      sourceRecords += 1;
      if (record?.event !== 'provider_rows' || !Array.isArray(record.raw_jobs)) {
        ignoredRecords += 1;
        continue;
      }
      providerRowsRecords += 1;
      for (const row of record.raw_jobs) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        rowsSeen += 1;
        const country = countryForRow(row);
        if (options.country && country !== options.country) continue;
        if (options.limit != null && overall.total >= options.limit) {
          limitReached = true;
          break;
        }

        const provider = String(record.provider || row.provider || 'unknown').toLowerCase();
        const titleValue = [row.title, ...(Array.isArray(row.seniority) ? row.seniority : [])]
          .filter(value => typeof value === 'string').join(' ');
        let stage;
        if (!titleFilter(titleValue)) stage = 'title_rejected';
        else if (!locationFilter(row.location, row.url, row.title)) stage = 'location_rejected';
        else if (!contentFilter(row.description, matchedTitleKeywords(row.title, config.title_filter))) stage = 'content_rejected';
        else stage = 'kept';

        increment(overall, stage);
        const countryCounts = byCountry.get(country) || counts();
        increment(countryCounts, stage);
        byCountry.set(country, countryCounts);
        const providerCounts = byProvider.get(provider) || counts();
        increment(providerCounts, stage);
        byProvider.set(provider, providerCounts);
        const countryProviders = byCountryProvider.get(country) || new Map();
        const countryProviderCounts = countryProviders.get(provider) || counts();
        increment(countryProviderCounts, stage);
        countryProviders.set(provider, countryProviderCounts);
        byCountryProvider.set(country, countryProviders);

        const outputRow = {
          ...row,
          provider,
          entry_name: record.entry_name ?? null,
          entry_url: record.entry_url ?? null,
          country,
        };
        if (stage === 'kept') {
          await writeLine(keptStream, outputRow);
        } else {
          if (rejectedSampleCounts[stage] < REJECT_SAMPLE_LIMIT_PER_STAGE) {
            rejectedSampleCounts[stage] += 1;
            await writeLine(rejectedStream, {
              provider,
              entry_name: record.entry_name ?? null,
              title: row.title ?? null,
              company: row.company ?? null,
              url: row.url ?? null,
              location: row.location ?? null,
              country,
              reason_code: stage,
            });
          }
        }

        if (typeof row.location === 'string' && FINLAND_LOCATION_RE.test(row.location)) {
          await writeLine(finlandStream, {
            title: row.title ?? null,
            company: row.company ?? null,
            url: row.url ?? null,
            provider,
            location: row.location,
            stage,
          });
        }
      }
      if (limitReached) break;
    }
    if (pendingRecord) {
      throw new Error(`Incomplete JSON on input record ${sourceRecords + 1} at end of file`);
    }
  } finally {
    keptStream.end();
    rejectedStream.end();
    finlandStream.end();
    await Promise.all([finished(keptStream), finished(rejectedStream), finished(finlandStream)]);
  }

  const byCountryProviderObject = Object.fromEntries([...byCountryProvider]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([country, providers]) => [country, Object.fromEntries([...providers]
      .sort(([left], [right]) => left.localeCompare(right)))]));
  const summary = {
    input: options.input,
    portals: options.portals,
    country_filter: options.country,
    limit: options.limit,
    source_records: sourceRecords,
    provider_rows_records: providerRowsRecords,
    ignored_records: ignoredRecords,
    input_rows_seen: rowsSeen,
    limit_reached: limitReached,
    overall,
    by_country: Object.fromEntries([...byCountry].sort(([left], [right]) => left.localeCompare(right))),
    by_provider: Object.fromEntries([...byProvider].sort(([left], [right]) => left.localeCompare(right))),
    by_country_provider: byCountryProviderObject,
    rejected_samples_written: rejectedSampleCounts,
    rejected_sample_limit_per_stage: REJECT_SAMPLE_LIMIT_PER_STAGE,
  };
  await writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return { outputDirectory, summary, elapsedMs: performance.now() - started };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await replay(options);
    console.log(`Filter replay completed in ${(result.elapsedMs / 1000).toFixed(2)}s`);
    console.log(`Output: ${result.outputDirectory}`);
    console.log(JSON.stringify(result.summary.overall));
  } catch (error) {
    console.error(`Filter replay failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
