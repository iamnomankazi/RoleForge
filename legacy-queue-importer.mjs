#!/usr/bin/env node

/** Explicit, fail-closed bridge from a historical queue into a v2 batch. */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplicationBatch, ROOT } from './application-batch.mjs';
import { hashFile, readSourceRunIntegrity } from './application-integrity.mjs';
import {
  canonicalListingUrl,
  collectCandidateIdentityAliases,
  deriveCandidateId,
  isCandidateId,
} from './candidate-identity.mjs';

function inline(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('Legacy queue CSV has an unterminated quoted field');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value.trim()));
}

function queueRows(queuePath) {
  const rows = parseCsv(readFileSync(queuePath, 'utf8').replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('Legacy queue must contain a header and at least one data row');
  const headers = rows[0].map((value) => inline(value).toLowerCase().replace(/[ -]+/g, '_'));
  if (new Set(headers).size !== headers.length) throw new Error('Legacy queue contains duplicate column names');
  return rows.slice(1).map((values, index) => {
    const record = Object.fromEntries(headers.map((header, column) => [header, inline(values[column])]));
    const urls = [...new Set([
      record.listing_url, record.url, record.job_url, record.apply_url,
    ].filter(Boolean))];
    for (const url of urls) canonicalListingUrl(url);
    return { rowNumber: index + 2, record, urls, candidateId: record.candidate_id || '' };
  });
}

function selectQueueRows(rows, { rowNumbers = [], urls = [], candidateIds = [] } = {}) {
  const selectorKinds = [rowNumbers.length > 0, urls.length > 0, candidateIds.length > 0].filter(Boolean).length;
  if (selectorKinds !== 1) throw new Error('Select legacy queue rows using exactly one selector type: --row, --url, or --candidate-id');
  const selectors = rowNumbers.length ? rowNumbers : (urls.length ? urls : candidateIds);
  if (rowNumbers.length && rowNumbers.some((value) => !Number.isInteger(value) || value < 2)) {
    throw new Error('Legacy queue --row selectors must be exact CSV row numbers (2 or greater)');
  }
  if (new Set(selectors).size !== selectors.length) throw new Error('Duplicate legacy queue selectors are not allowed');
  const selected = selectors.map((selector) => {
    const matches = rowNumbers.length
      ? rows.filter((row) => row.rowNumber === Number(selector))
      : urls.length
        ? rows.filter((row) => row.urls.includes(selector))
        : rows.filter((row) => row.candidateId === selector);
    if (matches.length !== 1) throw new Error(`Legacy queue selector must match exactly one row: ${selector}`);
    return matches[0];
  });
  if (new Set(selected.map((row) => row.rowNumber)).size !== selected.length) {
    throw new Error('Duplicate selectors resolve to the same legacy queue row');
  }
  return selected;
}

function normalizeSourceCandidate(row) {
  const candidateId = inline(row?.candidate_id ?? row?.candidateId) || deriveCandidateId(row, { legacy: true });
  const aliases = collectCandidateIdentityAliases(row).aliases.map(canonicalListingUrl);
  return { candidateId, aliases: [...new Set(aliases)] };
}

function matchQueueRowToRun(queueRow, sourceCandidates, sourceRunId) {
  let matches;
  if (queueRow.candidateId) {
    if (!isCandidateId(queueRow.candidateId)) throw new Error(`Queue row ${queueRow.rowNumber} has an invalid candidate_id`);
    matches = sourceCandidates.filter((candidate) => candidate.candidateId === queueRow.candidateId);
  } else {
    if (!queueRow.urls.length) throw new Error(`Queue row ${queueRow.rowNumber} has no candidate_id or URL`);
    const queueAliases = queueRow.urls.map(canonicalListingUrl);
    matches = sourceCandidates.filter((candidate) => queueAliases.some((url) => candidate.aliases.includes(url)));
  }
  if (matches.length === 0) throw new Error(`Queue row ${queueRow.rowNumber} does not match source run ${sourceRunId}`);
  if (matches.length > 1) throw new Error(`Queue row ${queueRow.rowNumber} is ambiguous in source run ${sourceRunId}`);
  return matches[0];
}

export function importLegacyQueue({
  root = ROOT,
  queueFile,
  sourceRunId,
  batchId = null,
  rowNumbers = [],
  selectedUrls = [],
  selectedCandidateIds = [],
  allowDuplicateReason = null,
  now = new Date(),
} = {}) {
  if (!queueFile) throw new Error('Explicit --queue-file is required; no global queue fallback is available');
  if (!sourceRunId) throw new Error('Explicit --source-run is required');
  const lexicalQueuePath = resolve(root, queueFile);
  if (!existsSync(lexicalQueuePath) || !statSync(lexicalQueuePath).isFile()) throw new Error(`Legacy queue file is missing: ${queueFile}`);
  const queuePath = realpathSync(lexicalQueuePath);
  const rows = queueRows(queuePath);
  const selected = selectQueueRows(rows, {
    rowNumbers: rowNumbers.map((value) => Number(value)),
    urls: selectedUrls,
    candidateIds: selectedCandidateIds,
  });
  const source = readSourceRunIntegrity(root, sourceRunId);
  const sourceCandidates = source.candidates.map(normalizeSourceCandidate);
  const matched = selected.map((row) => ({ row, candidate: matchQueueRowToRun(row, sourceCandidates, sourceRunId) }));
  const candidateIds = matched.map(({ candidate }) => candidate.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('Selected legacy queue rows resolve to the same source candidate');
  const queueHash = hashFile(queuePath);
  const legacyImport = {
    schemaVersion: 1,
    queueFile: queuePath,
    queueSha256: queueHash.sha256,
    queueSize: queueHash.size,
    importedAt: now.toISOString(),
    selectedRows: matched.map(({ row, candidate }) => ({
      rowNumber: row.rowNumber,
      candidate_id: candidate.candidateId,
      selectedUrl: row.urls[0] || candidate.aliases[0],
    })),
  };
  return createApplicationBatch({
    root,
    sourceRunId,
    batchId,
    selectedCandidateIds: candidateIds,
    legacyImport,
    allowDuplicateReason,
    now,
  });
}

function parseArgs(argv) {
  const options = { rowNumbers: [], selectedUrls: [], selectedCandidateIds: [] };
  const repeated = new Map([['--row', 'rowNumbers'], ['--url', 'selectedUrls'], ['--candidate-id', 'selectedCandidateIds']]);
  const singles = new Map([['--queue-file', 'queueFile'], ['--source-run', 'sourceRunId'], ['--batch-id', 'batchId']]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (repeated.has(arg)) options[repeated.get(arg)].push(value);
    else if (singles.has(arg)) {
      const key = singles.get(arg);
      if (options[key]) throw new Error(`Duplicate option: ${arg}`);
      options[key] = value;
    } else throw new Error(`Unknown option: ${arg}`);
    index += 1;
  }
  return options;
}

function usage() {
  return 'Usage: node legacy-queue-importer.mjs --queue-file <exact.csv> --source-run <run-id> [--batch-id <id>] (--row <csv-row>|--url <exact-queue-url>|--candidate-id <exact-id>) [...]';
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) return console.log(usage());
  const result = importLegacyQueue(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({
    batchId: result.manifest.batchId,
    sourceRunId: result.manifest.sourceRunId,
    candidateCount: result.manifest.expectedCandidateCount,
    manifest: result.manifestPath,
    state: result.statePath,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
