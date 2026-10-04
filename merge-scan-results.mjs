#!/usr/bin/env node

/**
 * Immutable multi-worker scan merger.
 *
 * Candidate normalization, identity, rendering, and immutable output are owned
 * by scan-candidate-contract.mjs so the standard scanner and worker merger
 * cannot drift into separate application-authority schemas.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atsIdentityFromUrl, canonicalListingUrl } from './candidate-identity.mjs';
import {
  buildImmutableScanRun,
  buildReviewCsv,
  buildReviewMarkdown,
  mergeCanonicalCandidates,
  normalizeCanonicalCandidate,
  writeImmutableScanRun,
} from './scan-candidate-contract.mjs';

const ROOT = process.cwd();

function usage(message = '') {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: node merge-scan-results.mjs [--dry-run] [--run-id ID] [--out-root DIR] <scan.json>...');
  process.exit(1);
}

export function parseJsonFile(filePath) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  if (Array.isArray(parsed)) return parsed;
  for (const key of ['offers', 'jobs', 'results', 'candidates']) {
    if (Array.isArray(parsed?.[key])) return parsed[key];
  }
  throw new Error('expected an array or an object containing offers/jobs/results/candidates');
}

export const canonicalUrl = canonicalListingUrl;
export const atsIdentity = atsIdentityFromUrl;
export const normalizeCandidate = normalizeCanonicalCandidate;
export const mergeCandidates = mergeCanonicalCandidates;
export { buildReviewCsv, buildReviewMarkdown, buildImmutableScanRun, writeImmutableScanRun };

function parseArgs(argv) {
  const files = [];
  let dryRun = false;
  let runId = '';
  let outRoot = 'output/scan-runs';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--run-id') runId = argv[++i] ?? usage('--run-id requires a value');
    else if (arg === '--out-root') outRoot = argv[++i] ?? usage('--out-root requires a value');
    else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (!files.length) usage('provide at least one JSON input');
  runId ||= `scan-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(runId)) usage('run id must be 1-120 safe filename characters');
  return { files, dryRun, runId, outRoot };
}

function main() {
  const { files, dryRun, runId, outRoot } = parseArgs(process.argv.slice(2));
  const inputs = files.map((file) => {
    const absolute = resolve(ROOT, file);
    if (!existsSync(absolute)) throw new Error(`input not found: ${file}`);
    return { name: basename(file), rows: parseJsonFile(absolute) };
  });
  const options = { runId, inputs, sourceArchitecture: 'worker_merge' };
  const result = dryRun
    ? buildImmutableScanRun(options)
    : writeImmutableScanRun({ root: ROOT, outRoot, ...options });
  console.log(JSON.stringify({ ...result.manifest, dryRun, output: result.runDir || null }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
