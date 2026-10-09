#!/usr/bin/env node
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildValidationReport,
  createDraftManifest,
  loadManifest,
  sha256,
  validateManifest,
} from './cv-claims.mjs';

const HELP = `Usage: node validate-cv-claims.mjs --cv <path> --anchors <path> [--json] [--strict]
       node validate-cv-claims.mjs --cv <path> --init <out> [--json] [--strict]

Options:
  --cv <path>       CV markdown input to check
  --anchors <path>  User-layer cv-claim-anchors.json manifest
  --init <out>      Write a new, unanchored draft using a hash-qualified filename
  --json            Print the full deterministic JSON report
  --strict          Exit nonzero if any claim is unanchored, stale, conflicted, or needs review
  --help            Show this help
`;
const EMPTY_COUNTS = Object.freeze({ asserted: 0, supported: 0, needs_review: 0, conflict: 0, stale: 0, unanchored: 0 });

function parseArgs(argv) {
  const options = { json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--json') { options.json = true; continue; }
    if (arg === '--strict') { options.strict = true; continue; }
    if (arg === '--cv' || arg === '--anchors' || arg === '--init') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path`);
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && !options.cv) throw new Error('--cv is required');
  if (!options.help && !options.init && !options.anchors) throw new Error('Use --anchors to validate or --init to create a draft');
  return options;
}

function qualifyOutput(path, inputHash) {
  const extension = extname(path) || '.json';
  const base = extname(path) ? path.slice(0, -extname(path).length) : path;
  return `${base}.${inputHash.slice(7, 19)}${extension}`;
}

async function writeNewFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx');
  try { await handle.writeFile(contents, 'utf8'); }
  finally { await handle.close(); }
}

function writeReport(report, json, initPath) {
  if (json) {
    console.log(JSON.stringify({ ...report, ...(initPath ? { draftPath: initPath } : {}) }, null, 2));
    return;
  }
  const counts = Object.entries(report.counts).map(([state, count]) => `${state}=${count}`).join(' ');
  console.log(`CV claim check: ${report.status}; ${counts}`);
  if (initPath) console.log(`Draft manifest written: ${initPath}`);
  if (report.errors?.length) console.error(`Manifest errors: ${report.errors.join(', ')}`);
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) { console.error(error.message); console.error('Run with --help for usage.'); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }

  const cvPath = resolve(options.cv);
  let cvText;
  try { cvText = await readFile(cvPath, 'utf8'); }
  catch (error) { console.error(`Could not read CV: ${error.message}`); process.exitCode = 2; return; }

  let manifest;
  let initPath;
  if (options.init) {
    manifest = createDraftManifest(cvText, 'cv.md');
    initPath = resolve(qualifyOutput(resolve(options.init), manifest.cv.inputHash));
    try { await writeNewFile(initPath, `${JSON.stringify(manifest, null, 2)}\n`); }
    catch (error) {
      const report = {
        schemaVersion: 1,
        input: { path: options.cv, hash: sha256(cvText.replace(/^\uFEFF/, '')) },
        status: 'blocked', counts: { ...EMPTY_COUNTS }, claims: [], delta: { added: [], unchanged: [], changed: [], removed: [] },
        errors: [error.code === 'EEXIST' ? 'init_collision' : `init_write_failed:${error.message}`],
      };
      writeReport(report, options.json, null);
      process.exitCode = 1;
      return;
    }
  } else {
    try { manifest = await loadManifest(resolve(options.anchors)); }
    catch (error) {
      const report = {
        schemaVersion: 1,
        input: { path: options.cv, hash: sha256(cvText.replace(/^\uFEFF/, '')) },
        status: 'blocked', counts: { ...EMPTY_COUNTS }, claims: [], delta: { added: [], unchanged: [], changed: [], removed: [] },
        errors: [error.message.split(':')[0]],
      };
      writeReport(report, options.json, null);
      process.exitCode = 1;
      return;
    }
  }

  const manifestErrors = validateManifest(manifest);
  const report = await buildValidationReport({ cvText, cvPath: options.cv, manifest, root: process.cwd() });
  writeReport(report, options.json, initPath);
  if (manifestErrors.length || report.status === 'blocked' || (options.strict && report.status !== 'pass')) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`CV claim check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
