#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchAtsPosting, resolveAtsApi } from './liveness-api.mjs';
import { htmlToText } from './providers/_html-to-text.mjs';

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_HOST_SPACING_MS = 250;

export function parseArgs(argv) {
  const options = { runDir: '', outDir: '', limit: null, only: null, noBrowser: false, concurrency: DEFAULT_CONCURRENCY };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { ...options, help: true };
    if (flag === '--no-browser') {
      if (options.noBrowser) throw new Error('Duplicate flag: --no-browser');
      options.noBrowser = true;
      continue;
    }
    if (!['--run', '--out', '--limit', '--only', '--concurrency'].includes(flag)) {
      throw new Error(`Unknown flag: ${flag}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--run') options.runDir = value;
    else if (flag === '--out') options.outDir = value;
    else if (flag === '--only') {
      const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      if (!ids.length) throw new Error('--only requires a comma-separated candidate_id list');
      options.only = new Set(ids);
    } else {
      if (!/^\d+$/.test(value)) throw new Error(`${flag} requires a positive integer`);
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${flag} requires a positive integer`);
      if (flag === '--limit') options.limit = number;
      else options.concurrency = Math.min(number, 32);
    }
  }
  if (!options.runDir) throw new Error('Missing required --run <scan-run-dir>');
  return options;
}

export function livenessHelp() {
  return [
    'Usage: node candidate-liveness.mjs --run <scan-run-dir> [options]',
    '',
    'Options:',
    '  --out <dir>                 Output directory (default: output/liveness/<run-id>-<timestamp>)',
    '  --limit <n>                 Process at most n candidates',
    '  --only <id,...>             Process selected candidate_id values',
    '  --no-browser                Do not use Playwright when the API is inconclusive',
    '  --concurrency <n>           Concurrent candidates (default: 4, maximum: 32)',
    '  --help                      Show this help',
  ].join('\n');
}

function timestampPart(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function safeCandidateFilename(candidateId) {
  if (typeof candidateId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(candidateId)
      || candidateId === '.' || candidateId === '..') {
    throw new Error(`Unsafe candidate_id for output file: ${String(candidateId)}`);
  }
  return `${candidateId}.txt`;
}

function cleanDescription(value) {
  if (typeof value !== 'string') return '';
  const text = /<(?:!?[a-z][\w:-]*|!--)|&lt;\s*\/?\s*[a-z][\w:-]*\b/i.test(value)
    ? htmlToText(value)
    : value.replace(/\s+/g, ' ').trim();
  return text;
}

function digest(text) {
  return text ? createHash('sha256').update(text, 'utf8').digest('hex') : null;
}

function candidateUrl(candidate) {
  return typeof candidate?.url === 'string' ? candidate.url : '';
}

function isWorkday(candidate) {
  return String(candidate?.ats_provider || '').toLowerCase() === 'workday'
    || /\.myworkdayjobs\.com\//i.test(candidateUrl(candidate));
}

function makeHostSpacer(spacingMs) {
  const tails = new Map();
  const lastStarted = new Map();
  return async function waitForHost(rawUrl) {
    let host;
    try { host = new URL(rawUrl).host.toLowerCase(); } catch { return; }
    const previous = tails.get(host) || Promise.resolve();
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    tails.set(host, previous.then(() => gate));
    await previous;
    const remaining = spacingMs - (Date.now() - (lastStarted.get(host) || 0));
    if (remaining > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
    lastStarted.set(host, Date.now());
    release();
  };
}

async function browserCheck(url, browser) {
  const { checkUrlLiveness, newLivenessPage } = await import('./liveness-browser.mjs');
  const livenessPage = await newLivenessPage(browser);
  const context = livenessPage.context();
  try {
    const result = await checkUrlLiveness(livenessPage, url);
    const finalUrl = livenessPage.url();
    const pageData = await livenessPage.evaluate(() => {
      const selectors = [
        '[data-automation-id="jobPostingDescription"]', '[data-testid*="description" i]',
        '[class*="job-description" i]', '[class*="posting-description" i]',
        'article', 'main',
      ];
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        const text = element?.innerText?.trim();
        if (text && text.length >= 100) return text;
      }
      return document.body?.innerText ?? '';
    });
    return { result, finalUrl, description: cleanDescription(pageData) };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Process an immutable scan run and write the liveness manifest and captured JDs.
 * Exported for offline fixture tests; production uses the same code path.
 */
export async function runCandidateLiveness({
  runDir,
  outDir,
  limit = null,
  only = null,
  noBrowser = false,
  concurrency = DEFAULT_CONCURRENCY,
  fetchImpl = fetch,
  hostSpacingMs = DEFAULT_HOST_SPACING_MS,
  now = () => new Date(),
  log = console.log,
} = {}) {
  const sourcePath = join(resolve(runDir), 'candidates.json');
  const runPath = resolve(runDir);
  const runId = basename(runPath);
  const outputDir = resolve(outDir || join(process.cwd(), 'output', 'liveness', `${runId}-${timestampPart(now())}`));
  const outputRelativeToRun = relative(runPath, outputDir);
  if (outputRelativeToRun === '' || (!isAbsolute(outputRelativeToRun)
      && outputRelativeToRun !== '..' && !outputRelativeToRun.startsWith(`..${sep}`))) {
    throw new Error('Output directory must stay outside the immutable scan run');
  }
  const input = JSON.parse(await readFile(sourcePath, 'utf8'));
  if (!Array.isArray(input)) throw new Error(`${sourcePath} must contain a JSON array of candidates`);
  const selected = input.filter((candidate) => !only || only.has(candidate?.candidate_id));
  const candidates = limit == null ? selected : selected.slice(0, limit);
  const ids = new Set();
  for (const candidate of candidates) {
    safeCandidateFilename(candidate?.candidate_id);
    if (ids.has(candidate.candidate_id)) throw new Error(`Duplicate candidate_id in scan run: ${candidate.candidate_id}`);
    ids.add(candidate.candidate_id);
  }
  const outputRows = Object.create(null);
  const descriptionsDir = join(outputDir, 'descriptions');
  await mkdir(descriptionsDir, { recursive: true });

  let browser = null;
  let browserPromise = null;
  const ensureBrowser = async () => {
    if (browser) return browser;
    if (!browserPromise) {
      browserPromise = import('playwright').then(({ chromium }) => chromium.launch({ headless: true }));
    }
    browser = await browserPromise;
    return browser;
  };
  const waitForHost = makeHostSpacer(Math.max(0, Number(hostSpacingMs) || 0));
  let nextIndex = 0;
  let workdayPreviouslyEmptyWithDescription = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      const candidateId = candidate?.candidate_id;
      let status = 'unconfirmed';
      let method = 'none';
      let reason = 'missing candidate URL or candidate_id';
      let finalUrl = candidateUrl(candidate) || null;
      const priorDescription = cleanDescription(candidate?.description);
      let description = priorDescription;

      try {
        safeCandidateFilename(candidateId);
        if (!candidateUrl(candidate)) throw new Error('candidate has no absolute posting URL');
        const resolved = resolveAtsApi(candidateUrl(candidate));
        if (resolved) await waitForHost(resolved.apiUrl);
        const apiResult = await fetchAtsPosting(candidateUrl(candidate), { fetchImpl });
        if (apiResult) {
          status = apiResult.result === 'active' ? 'active' : 'expired';
          method = 'api';
          reason = apiResult.reason;
          finalUrl = apiResult.finalUrl || finalUrl;
          if (apiResult.description) description = apiResult.description;
        } else if (noBrowser) {
          reason = resolved ? 'ATS API was inconclusive; browser fallback disabled' : 'no supported ATS API; browser fallback disabled';
        } else {
          try {
            await waitForHost(candidateUrl(candidate));
            const currentBrowser = await ensureBrowser();
            const browserResult = await browserCheck(candidateUrl(candidate), currentBrowser);
            status = browserResult.result.result === 'active' ? 'active'
              : browserResult.result.result === 'expired' ? 'expired' : 'unconfirmed';
            method = 'browser';
            reason = browserResult.result.reason;
            finalUrl = browserResult.finalUrl || finalUrl;
            if (browserResult.description) description = browserResult.description;
          } catch (error) {
            reason = `browser fallback failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`;
          }
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }

      const checkedAt = now().toISOString();
      const record = {
        status,
        method,
        checked_at: checkedAt,
        final_url: finalUrl,
        description_chars: description.length,
        description_sha256: digest(description),
        reason,
      };
      outputRows[candidateId] = record;
      if (description) await writeFile(join(descriptionsDir, safeCandidateFilename(candidateId)), `${description}\n`, 'utf8');
      if (isWorkday(candidate) && !priorDescription && description) workdayPreviouslyEmptyWithDescription++;
    }
  };

  try {
    const workerCount = Math.min(Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : DEFAULT_CONCURRENCY, candidates.length || 1);
    await Promise.all(Array.from({ length: workerCount }, worker));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  await writeFile(join(outputDir, 'liveness.json'), `${JSON.stringify(outputRows, null, 2)}\n`, 'utf8');
  const statusCounts = { active: 0, expired: 0, unconfirmed: 0 };
  const methodCounts = { api: 0, browser: 0, none: 0 };
  for (const record of Object.values(outputRows)) {
    statusCounts[record.status]++;
    methodCounts[record.method]++;
  }
  const workdayTotal = candidates.filter(isWorkday).length;
  log(`Results: ${candidates.length} candidates; status active=${statusCounts.active} expired=${statusCounts.expired} unconfirmed=${statusCounts.unconfirmed}; method api=${methodCounts.api} browser=${methodCounts.browser} none=${methodCounts.none}`);
  log(`Previously description-less Workday candidates now captured: ${workdayPreviouslyEmptyWithDescription}/${workdayTotal}`);
  log(`Output: ${outputDir}`);
  return { outputDir, outputRows, statusCounts, methodCounts, workdayPreviouslyEmptyWithDescription, workdayTotal };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${livenessHelp()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(livenessHelp());
    return;
  }
  await runCandidateLiveness(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
