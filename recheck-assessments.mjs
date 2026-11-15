#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validateMachineSummary } from './assessment-contract.mjs';
import { normalizeExperiencePolicy } from './experience-policy.mjs';
import { findGraduationDates } from './profile-fact-check.mjs';
import { loadPrescreenProfile, prescreenJob } from './prescreen.mjs';
import {
  findCandidateRecord, loadIdentityMappings, loadReportIndex, loadRunCandidates,
} from './tracker-identity.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const textValue = (value) => typeof value === 'string' ? value.trim() : '';

function candidateIdFrom(report, summary) {
  return textValue(report?.candidateId) || textValue(summary?.candidate_id ?? summary?.candidateId) || null;
}

function graduationBlockers(summary) {
  const blockers = [
    ...(Array.isArray(summary?.blockers) ? summary.blockers : []),
    ...(Array.isArray(summary?.prescreen?.blockers) ? summary.prescreen.blockers : []),
  ];
  return blockers.filter((item) => item && typeof item === 'object' && item.code === 'graduation_window');
}

function reportBlockerCodes(summary) {
  const blockers = [
    ...(Array.isArray(summary?.blockers) ? summary.blockers : []),
    ...(Array.isArray(summary?.prescreen?.blockers) ? summary.prescreen.blockers : []),
  ];
  return [...new Set(blockers.map((item) => typeof item === 'string' ? item : item?.code).filter((code) => typeof code === 'string'))];
}

function evidenceValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(evidenceValues);
  if (value && typeof value === 'object') {
    if (typeof value.evidence === 'string') return [value.evidence];
    return Object.values(value).flatMap(evidenceValues);
  }
  return [];
}

function mentionsGraduationTiming(summary) {
  const evidence = [
    ...evidenceValues(summary?.soft_gaps),
    ...evidenceValues(summary?.flags),
    ...evidenceValues(summary?.blockers),
    ...evidenceValues(summary?.prescreen?.flags),
    ...evidenceValues(summary?.prescreen?.blockers),
    ...evidenceValues(summary?.next_action),
  ];
  return evidence.some((value) => /\bgraduat\w*\b/i.test(value) || findGraduationDates(value).length > 0);
}

function citedDates(summary) {
  const values = [
    ...evidenceValues(summary?.soft_gaps),
    ...evidenceValues(summary?.flags),
    ...evidenceValues(summary?.blockers),
    ...evidenceValues(summary?.prescreen?.flags),
    ...evidenceValues(summary?.prescreen?.blockers),
    ...evidenceValues(summary?.next_action),
  ];
  // A graduation_window blocker's evidence is graduation-related by definition,
  // even when the quoted date is shown without surrounding graduation wording.
  const contextualBlockerEvidence = graduationBlockers(summary)
    .flatMap((blocker) => evidenceValues(blocker.evidence))
    .map((value) => `Graduation date: ${value}`);
  return [...values, ...contextualBlockerEvidence];
}

function profileDateParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
}

function addCitationDetails(entry, summary, profileGraduationDate) {
  const current = profileDateParts(profileGraduationDate);
  const citations = new Map();
  for (const value of citedDates(summary)) {
    for (const date of findGraduationDates(value)) {
      const normalized = date.month == null
        ? String(date.year)
        : `${date.year}-${String(date.month).padStart(2, '0')}`;
      citations.set(normalized, date);
    }
  }
  entry.cites_profile_dates = [...citations.keys()];
  entry.cites_stale_profile_date = current
    ? [...citations.values()].some((date) => date.year !== current.year
      || (date.month != null && date.month !== current.month))
    : false;
}

function safeDescriptionFilename(candidateId) {
  const filename = `${candidateId}.txt`;
  return /^[A-Za-z0-9._-]{1,200}\.txt$/.test(filename) && candidateId !== '.' && candidateId !== '..'
    ? filename : null;
}

function loadLivenessDescription(livenessDir, candidateId, warnings, manifestCache) {
  const file = join(livenessDir, 'liveness.json');
  let manifest = manifestCache.get(file);
  if (!manifest) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object keyed by candidate_id');
      manifest = { value: parsed };
    } catch (error) {
      manifest = { error: error?.code === 'ENOENT' ? 'missing liveness.json' : `could not read liveness.json: ${error.message}` };
    }
    manifestCache.set(file, manifest);
    if (manifest.error) warnings.push(`${basename(livenessDir)}: ${manifest.error}`);
  }
  if (manifest.error) return null;
  const record = manifest.value[candidateId];
  if (!record || typeof record.description_sha256 !== 'string') return null;
  const filename = safeDescriptionFilename(candidateId);
  if (!filename) return null;
  const descriptionPath = join(livenessDir, 'descriptions', filename);
  let stored;
  try { stored = readFileSync(descriptionPath, 'utf8'); } catch { return null; }
  if (!stored.endsWith('\n')) return null;
  const description = stored.slice(0, -1);
  const digest = sha256(Buffer.from(description, 'utf8'));
  if (digest !== record.description_sha256) return null;
  return { description, digest, source: resolve(livenessDir) };
}

function descriptionFor({ candidateId, runRecord, livenessDirs, warnings, manifestCache }) {
  const runDescription = typeof runRecord?.description === 'string' ? runRecord.description : '';
  if (runDescription.length >= 120) {
    return {
      description: runDescription,
      digest: sha256(Buffer.from(runDescription, 'utf8')),
      source: textValue(runRecord.run_id) || 'scan-run',
    };
  }
  for (const livenessDir of livenessDirs) {
    const captured = loadLivenessDescription(livenessDir, candidateId, warnings, manifestCache);
    if (captured) return captured;
  }
  return null;
}

function entryBase({ reportNumber, summary, candidateId, validation }) {
  return {
    report: reportNumber,
    file: '',
    candidate_id: candidateId,
    title: textValue(summary?.title) || textValue(summary?.role),
    company: textValue(summary?.company),
    action: validation.action,
    report_blockers: reportBlockerCodes(summary),
    replay_graduation: null,
    replay_blocker: null,
    description_source: null,
    description_sha256: null,
  };
}

function isInside(target, directory) {
  const path = relative(directory, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  while (true) {
    try { return resolve(realpathSync(current), ...suffix); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function assertSafeOutput(outPath, { root, profilePath, livenessDirs }) {
  const canonicalOut = canonicalPath(outPath);
  const protectedDirs = [
    ...['reports', 'data', 'config', 'output/scan-runs', 'output/application-batches', 'output/identity-corrections']
      .map((part) => [join(root, part), `${part}/`]),
    ...livenessDirs.map((directory) => [directory, 'liveness evidence directories']),
  ];
  for (const [directory, label] of protectedDirs) {
    if (isInside(outPath, directory) || isInside(canonicalOut, canonicalPath(directory))) {
      throw new Error(`--out cannot point inside ${label}`);
    }
  }
  const protectedFiles = [profilePath, join(root, 'cv.md'), join(root, 'modes', '_profile.md')];
  if (protectedFiles.some((file) => relative(file, outPath) === '' || relative(canonicalPath(file), canonicalOut) === '')) {
    throw new Error('--out cannot overwrite the profile, CV, or profile notes');
  }
  return canonicalOut;
}

/** Replays deterministic graduation-window prescreening without changing inputs. */
export function recheckAssessments({ root = process.cwd(), profilePath, livenessDirs = [] } = {}) {
  const projectRoot = resolve(root);
  const profileFile = resolve(profilePath ?? join(projectRoot, 'config', 'profile.yml'));
  const profileBytes = readFileSync(profileFile);
  const profileDocument = yaml.load(profileBytes.toString('utf8').replace(/^\uFEFF/, '')) ?? {};
  if (!profileDocument || typeof profileDocument !== 'object' || Array.isArray(profileDocument)) {
    throw new Error(`Profile must contain a YAML object: ${profileFile}`);
  }
  const profile = loadPrescreenProfile(profileFile);
  const experiencePolicy = normalizeExperiencePolicy(profileDocument.experience_policy);
  const reportsDir = join(projectRoot, 'reports');
  const scanRunsDir = join(projectRoot, 'output', 'scan-runs');
  const correctionsDir = join(projectRoot, 'output', 'identity-corrections');
  const reportIndex = loadReportIndex(reportsDir);
  const runCandidates = loadRunCandidates(scanRunsDir);
  const mappings = loadIdentityMappings({ scanRunsDir, correctionsDir });
  const warnings = [...(reportIndex.warnings ?? []), ...(runCandidates.warnings ?? []), ...(mappings.warnings ?? [])];
  const superseded = new Set([...reportIndex.values()].map((report) => report.supersedes).filter(Number.isFinite));
  const lists = {
    blocker_would_clear: [], blocker_still_applies: [], blocker_not_reproducible: [],
    blocker_would_appear: [], wording_mentions_graduation: [], cannot_check: [],
  };
  const counts = {
    blocker_would_clear: 0, blocker_still_applies: 0, blocker_not_reproducible: 0,
    blocker_would_appear: 0, wording_mentions_graduation: 0,
    cannot_check: 0, unchanged: 0, skipped_legacy: 0, skipped_superseded: 0,
  };
  const manifestCache = new Map();
  const livenessPaths = livenessDirs.map((path) => resolve(path));

  for (const [reportNumber, report] of reportIndex) {
    if (superseded.has(reportNumber)) {
      counts.skipped_superseded += 1;
      continue;
    }
    const summary = report.summary;
    if (summary?.legacy) {
      counts.skipped_legacy += 1;
      continue;
    }
    if (!summary || (Array.isArray(summary.errors) && summary.errors.length)) {
      warnings.push(`Skipped report ${report.file}: Machine Summary is missing or could not be parsed`);
      continue;
    }
    const validation = validateMachineSummary(summary);
    if (!validation.valid) warnings.push(`Report ${report.file} has an invalid assessment: ${validation.errors.join('; ')}`);
    const candidateId = candidateIdFrom(report, summary);
    const entry = entryBase({ reportNumber, summary, candidateId, validation });
    entry.file = relative(projectRoot, report.file).split(sep).join('/');
    addCitationDetails(entry, summary, profile.graduation_date);
    const reportHasBlocker = graduationBlockers(summary).length > 0;
    const reportMentionsGraduation = mentionsGraduationTiming(summary);

    const cannotCheck = (reason) => {
      counts.cannot_check += 1;
      lists.cannot_check.push({ ...entry, reason });
    };
    if (!profile.graduation_date && (reportHasBlocker || reportMentionsGraduation)) {
      cannotCheck('no_profile_graduation_date');
      continue;
    }
    if (!candidateId) {
      cannotCheck('no_candidate_id');
      continue;
    }
    const runRecord = findCandidateRecord(runCandidates, mappings, candidateId);
    const description = descriptionFor({ candidateId, runRecord, livenessDirs: livenessPaths, warnings, manifestCache });
    if (!description) {
      cannotCheck('no_verified_description');
      continue;
    }

    const title = textValue(runRecord?.title) || textValue(summary.title) || textValue(summary.role);
    const company = textValue(runRecord?.company) || textValue(summary.company);
    const location = textValue(runRecord?.location) || textValue(summary.location) || textValue(summary.location_country);
    entry.title = title;
    entry.company = company;
    entry.description_source = description.source;
    entry.description_sha256 = description.digest;
    const replay = prescreenJob({ title, description: description.description, location }, profile, { experiencePolicy });
    entry.replay_graduation = replay.graduation_window;
    const replayBlocker = replay.blockers.find((blocker) => blocker.code === 'graduation_window') ?? null;
    entry.replay_blocker = replayBlocker ? { evidence: replayBlocker.evidence, detail: replayBlocker.detail } : null;
    if (reportHasBlocker && replayBlocker) {
      counts.blocker_still_applies += 1;
      lists.blocker_still_applies.push(entry);
    } else if (reportHasBlocker && replay.graduation_window?.eligible === true) {
      counts.blocker_would_clear += 1;
      lists.blocker_would_clear.push(entry);
    } else if (reportHasBlocker && replay.graduation_window == null) {
      counts.blocker_not_reproducible += 1;
      lists.blocker_not_reproducible.push(entry);
    } else if (!reportHasBlocker && replayBlocker) {
      counts.blocker_would_appear += 1;
      lists.blocker_would_appear.push(entry);
    } else if (reportMentionsGraduation) {
      counts.wording_mentions_graduation += 1;
      lists.wording_mentions_graduation.push(entry);
    } else {
      counts.unchanged += 1;
    }
  }

  return {
    schema: 'recheck-assessments/1',
    generated_at: new Date().toISOString(),
    profile_graduation_date: profile.graduation_date,
    profile_sha256: sha256(profileBytes),
    lists,
    counts,
    warnings,
  };
}

function parseArgs(args) {
  const parsed = { root: process.cwd(), livenessDirs: [], json: false, out: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (['--root', '--profile', '--liveness', '--out'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      index += 1;
      if (arg === '--liveness') parsed.livenessDirs.push(value);
      else parsed[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

const HELP = `Usage: node recheck-assessments.mjs [options]

Options:
  --root <project-root>  Project data root (default: current directory)
  --profile <profile.yml>  Profile YAML (default: <root>/config/profile.yml)
  --liveness <dir>  Verified liveness output directory (repeatable)
  --json  Print the complete JSON result
  --out <file>  Write the complete JSON result to a file
  --help  Show this help`;

function printHuman(result) {
  console.log(`Graduation assessment recheck (${result.profile_graduation_date ?? 'no profile date'})`);
  console.log(`Counts: ${JSON.stringify(result.counts)}`);
  for (const key of [
    'blocker_would_clear', 'blocker_still_applies', 'blocker_not_reproducible',
    'blocker_would_appear', 'wording_mentions_graduation',
  ]) {
    console.log(`\n${key.replaceAll('_', ' ')} (${result.lists[key].length})`);
    for (const entry of result.lists[key]) {
      console.log(`  #${entry.report} ${entry.title || '(untitled)'} cites_stale_profile_date=${entry.cites_stale_profile_date ?? false}`);
    }
  }
  if (result.warnings.length) console.log(`\nWarnings: ${result.warnings.length}`);
}

function runCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { console.log(HELP); return; }
    const result = recheckAssessments({ root: args.root, profilePath: args.profile, livenessDirs: args.livenessDirs });
    if (args.out) {
      const outPath = resolve(args.out);
      const root = resolve(args.root);
      const safeOutPath = assertSafeOutput(outPath, { root, profilePath: resolve(args.profile ?? join(root, 'config', 'profile.yml')), livenessDirs: args.livenessDirs.map((path) => resolve(path)) });
      writeFileSync(safeOutPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } catch (error) {
    console.error(`recheck-assessments.mjs: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
