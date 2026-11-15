#!/usr/bin/env node
import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import {
  atsIdentityFromUrl,
  candidateIdentityMetadata,
} from './candidate-identity.mjs';
import {
  buildImmutableScanRun,
  normalizeCanonicalCandidate,
  writeImmutableScanRun,
} from './scan-candidate-contract.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPLICIT_TENANT_KEYS = [
  'ats_tenant', 'atsTenant', 'tenant', 'boardToken', 'board_token',
  'companyIdentifier', 'company_identifier', 'companySlug', 'company_slug',
];
const EXPLICIT_IDENTITY_KEYS = [
  'ats_provider', 'atsProvider', 'ats_tenant', 'atsTenant', 'tenant', 'boardToken', 'board_token',
  'companyIdentifier', 'company_identifier', 'companySlug', 'company_slug',
  'requisition_id', 'requisitionId', 'jobId', 'job_id', 'requisition', 'provider',
];
const OVERRIDE_KEYS = new Set(['apply_url', 'listing_url', 'company', 'reason']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function contractText(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function validRunId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(String(value || ''));
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} ${file}: ${error.message}`);
  }
}

function validateHttpUrl(value, label, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /\s/.test(value)) {
    throw new Error(`${label} must be an absolute ${httpsOnly ? 'https' : 'http(s)'} URL`);
  }
  let url;
  try { url = new URL(value); } catch {
    throw new Error(`${label} must be an absolute ${httpsOnly ? 'https' : 'http(s)'} URL`);
  }
  if ((httpsOnly && url.protocol !== 'https:')
      || (!httpsOnly && !['http:', 'https:'].includes(url.protocol))
      || !url.hostname || url.username || url.password) {
    throw new Error(`${label} must be an absolute ${httpsOnly ? 'https' : 'http(s)'} URL`);
  }
  return url;
}

function validateOverrides(overrides, sourceIds) {
  if (overrides == null) return {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Overrides must be a JSON object keyed by source candidate_id');
  }
  const validated = {};
  for (const [candidateId, entry] of Object.entries(overrides)) {
    if (!sourceIds.has(candidateId)) throw new Error(`Override references unknown source candidate_id: ${candidateId}`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Override for ${candidateId} must be an object`);
    }
    for (const key of Object.keys(entry)) {
      if (!OVERRIDE_KEYS.has(key)) throw new Error(`Unknown override key for ${candidateId}: ${key}`);
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      throw new Error(`Override for ${candidateId} requires a non-empty reason`);
    }
    if (Object.hasOwn(entry, 'apply_url') && Object.hasOwn(entry, 'listing_url')) {
      throw new Error(`Override for ${candidateId} cannot set both apply_url and listing_url`);
    }
    if (Object.hasOwn(entry, 'apply_url')) {
      validateHttpUrl(entry.apply_url, `Override apply_url for ${candidateId}`, { httpsOnly: true });
      if (!atsIdentityFromUrl(entry.apply_url)) {
        throw new Error(`Override apply_url for ${candidateId} must identify a supported ATS posting`);
      }
    }
    if (Object.hasOwn(entry, 'listing_url')) {
      validateHttpUrl(entry.listing_url, `Override listing_url for ${candidateId}`);
    }
    if (Object.hasOwn(entry, 'company') && (typeof entry.company !== 'string' || !entry.company.trim())) {
      throw new Error(`Override company for ${candidateId} must be a non-empty string`);
    }
    validated[candidateId] = { ...entry };
  }
  return validated;
}

function candidateListingUrl(row) {
  return row?.original_url || row?.originalUrl || row?.url || row?.listing_url || row?.listingUrl || null;
}

function explicitIdentityValues(row) {
  return Object.fromEntries(EXPLICIT_IDENTITY_KEYS
    .filter((key) => row?.[key] != null && row[key] !== '')
    .map((key) => [key, row[key]]));
}

function sourceRows(runDir) {
  const manifestPath = join(runDir, 'manifest.json');
  const candidatesPath = join(runDir, 'candidates.json');
  if (!existsSync(manifestPath) || !existsSync(candidatesPath)) {
    throw new Error(`Source run must contain manifest.json and candidates.json: ${runDir}`);
  }
  const manifest = readJson(manifestPath, 'source manifest');
  const candidates = readJson(candidatesPath, 'source candidates');
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Source manifest must be an object: ${manifestPath}`);
  }
  if (!Array.isArray(candidates)) throw new Error(`Source candidates must be an array: ${candidatesPath}`);
  const seen = new Set();
  for (const [index, row] of candidates.entries()) {
    const id = row?.candidate_id;
    if (typeof id !== 'string' || !id) throw new Error(`Source candidate ${index + 1} is missing candidate_id`);
    if (seen.has(id)) throw new Error(`Source run contains duplicate candidate_id: ${id}`);
    seen.add(id);
  }
  return { manifest, candidates, sourceIds: seen };
}

function loadLiveness(livenessDir) {
  const file = join(livenessDir, 'liveness.json');
  if (!existsSync(file)) throw new Error(`Liveness directory is missing liveness.json: ${file}`);
  const bytes = readFileSync(file);
  let rows;
  try { rows = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new Error(`Could not parse liveness manifest ${file}: ${error.message}`);
  }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) {
    throw new Error(`Liveness manifest must be an object keyed by candidate_id: ${file}`);
  }
  return { rows, bytes, file };
}

function loadPortalConfig(root, warnings) {
  const portalsPath = join(root, 'portals.yml');
  if (!existsSync(portalsPath)) {
    warnings.push(`portals.yml not found at ${portalsPath}; company names were not updated from tracked companies`);
    return null;
  }
  try {
    const config = yaml.load(readFileSync(portalsPath, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('expected a YAML object');
    }
    return config;
  } catch (error) {
    warnings.push(`Could not parse portals.yml at ${portalsPath}: ${error.message}; company names were not updated`);
    return null;
  }
}

function normalizePart(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function tenantFromPostingUrl(value) {
  const identity = atsIdentityFromUrl(value);
  const parts = identity.split(':');
  return parts.length >= 4 ? { provider: parts[1], tenant: parts.slice(2, -1).join(':') } : null;
}

async function portalCompanyNames(config) {
  const entries = Array.isArray(config?.tracked_companies) ? config.tracked_companies : [];
  const providers = await loadProviders(join(SCRIPT_DIR, 'providers'));
  return (candidate) => {
    const candidateProvider = candidate?.ats_provider ?? candidate?.atsProvider;
    const candidateTenant = candidate?.ats_tenant ?? candidate?.atsTenant;
    if (!candidateProvider || !candidateTenant) return null;
    const providerId = normalizePart(candidateProvider);
    const tenant = normalizePart(candidateTenant);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || entry.enabled === false || typeof entry.name !== 'string' || !entry.name.trim()) continue;
      const resolved = resolveProvider(entry, providers);
      if (!resolved?.provider || normalizePart(resolved.provider.id) !== providerId) continue;
      const configuredTenants = EXPLICIT_TENANT_KEYS.map((key) => entry[key]).filter(Boolean);
      for (const value of [entry.careers_url, entry.url]) {
        const fromUrl = tenantFromPostingUrl(value);
        if (fromUrl?.provider === providerId) configuredTenants.push(fromUrl.tenant);
      }
      if (configuredTenants.some((value) => normalizePart(value) === tenant)) return entry.name.trim();
    }
    return null;
  };
}

function verifyDescription(livenessDir, candidateId, record) {
  if (record?.status !== 'active') return { ok: false, reason: `liveness_status_${String(record?.status || 'missing')}` };
  const filename = `${candidateId}.txt`;
  if (!/^[A-Za-z0-9._-]{1,200}\.txt$/.test(filename) || candidateId === '.' || candidateId === '..') {
    return { ok: false, reason: 'unsafe_description_filename' };
  }
  const file = join(livenessDir, 'descriptions', filename);
  let stored;
  try { stored = readFileSync(file, 'utf8'); } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'description_file_missing' : `description_file_read_error:${error.message}` };
  }
  if (!stored.endsWith('\n')) return { ok: false, reason: 'missing_trailing_newline' };
  const text = stored.slice(0, -1);
  const digest = sha256(Buffer.from(text, 'utf8'));
  if (digest !== record.description_sha256) return { ok: false, reason: 'description_sha256_mismatch' };
  if (text.length !== record.description_chars) return { ok: false, reason: 'description_chars_mismatch' };
  return { ok: true, text, digest };
}

function leftoverStaging(root, runId, warnings) {
  const outputRoot = join(root, 'output', 'scan-runs');
  if (!existsSync(outputRoot)) return [];
  const pattern = new RegExp(`^\\.${runId.replaceAll('.', '\\.')}\\..+\\.staging$`);
  const leftovers = readdirSync(outputRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => join(outputRoot, entry.name));
  if (leftovers.length) warnings.push(`Found leftover staging directories for ${runId}: ${leftovers.join(', ')}`);
  return leftovers;
}

function previewFrom(entries, sourceCandidates, builtCandidates) {
  const idChanges = entries.filter((entry) => entry.source_candidate_id !== entry.candidate_id)
    .map(({ source_candidate_id, candidate_id }) => ({ source_candidate_id, candidate_id }));
  const fills = entries.filter((entry) => entry.changes.includes('description_filled'))
    .map(({ source_candidate_id, candidate_id }) => ({ source_candidate_id, candidate_id }));
  const urlChanges = entries.filter((entry) => entry.changes.includes('apply_url_override')
      || entry.changes.includes('listing_url_resourced'))
    .map(({ source_candidate_id, changes, previous_listing_url, candidate_id }) => {
      const target = builtCandidates.find((candidate) => candidate.candidate_id === candidate_id);
      return {
        source_candidate_id,
        candidate_id,
        changes,
        previous_listing_url,
        listing_url: target?.url ?? null,
        apply_url: target?.apply_url ?? null,
      };
    });
  const convergences = entries.filter((entry) => entry.converged === true)
    .map(({ source_candidate_id, candidate_id }) => ({ source_candidate_id, candidate_id }));
  return {
    source_candidates: sourceCandidates.length,
    output_candidates: builtCandidates.length,
    id_changes: idChanges,
    description_fills: fills,
    url_changes: urlChanges,
    convergences,
  };
}

/** Build and validate an offline enrichment plan without writing files. */
export async function planEnrichment({
  runDir,
  livenessDir,
  outRunId,
  overridesPath = null,
  overrides = undefined,
  root = process.cwd(),
  createdAt = new Date().toISOString(),
} = {}) {
  if (!runDir) throw new Error('Missing source run directory');
  if (!livenessDir) throw new Error('Missing liveness directory');
  if (!validRunId(outRunId)) throw new Error('run ID must be 1-120 safe filename characters');
  const projectRoot = resolve(root);
  const sourceDir = resolve(runDir);
  const liveDir = resolve(livenessDir);
  const source = sourceRows(sourceDir);
  const liveness = loadLiveness(liveDir);
  let overridesBytes = null;
  if (overridesPath) {
    const path = resolve(overridesPath);
    overridesBytes = readFileSync(path);
    try { overrides = JSON.parse(overridesBytes.toString('utf8')); } catch (error) {
      throw new Error(`Could not parse overrides ${path}: ${error.message}`);
    }
  }
  const ownerOverrides = validateOverrides(overrides, source.sourceIds);
  const overridesHash = overridesBytes ? sha256(overridesBytes)
    : overrides === undefined || overrides === null ? null : sha256(Buffer.from(JSON.stringify(overrides), 'utf8'));
  const warnings = [];
  const portalConfig = loadPortalConfig(projectRoot, warnings);
  const companyForCandidate = portalConfig ? await portalCompanyNames(portalConfig) : () => null;
  const outRoot = join(projectRoot, 'output', 'scan-runs');
  const targetDir = join(outRoot, outRunId);
  if (existsSync(targetDir)) throw new Error(`Immutable scan run already exists (EEXIST): ${targetDir}`);
  const stagingDirs = leftoverStaging(projectRoot, outRunId, warnings);

  const transformed = [];
  const sourceMetadata = [];
  const sourceRunId = String(source.manifest.run_id || source.manifest.runId || basename(sourceDir));
  for (const [index, original] of source.candidates.entries()) {
    const sourceId = original.candidate_id;
    const row = structuredClone(original);
    const owner = ownerOverrides[sourceId];
    const changes = [];
    const reasons = [];
    const previousListingUrl = candidateListingUrl(original);
    let previousAtsIdentity = null;
    let descriptionFailure = null;
    const record = liveness.rows[sourceId] && typeof liveness.rows[sourceId] === 'object'
      ? liveness.rows[sourceId] : null;
    const isResourced = Boolean(owner && Object.hasOwn(owner, 'listing_url'));
    let mappingLivenessStatus = record?.status ?? null;
    let checkedAt = record?.checked_at ?? null;
    let descriptionDigest = null;
    let storedDescriptionDigest = null;

    if (isResourced) {
      previousAtsIdentity = explicitIdentityValues(row);
      for (const key of EXPLICIT_IDENTITY_KEYS) delete row[key];
      row.url = owner.listing_url;
      row.original_url = owner.listing_url;
      row.resolved_url = null;
      row.apply_url = null;
      row.applyUrl = null;
      row.canonical_url = null;
      row.url_aliases = [];
      row.source_url = row.source_url || row.sourceUrl || previousListingUrl;
      row.liveness_status = 'unconfirmed';
      row.livenessStatus = 'unconfirmed';
      row.liveness_code = 'enrich:unconfirmed';
      row.livenessCode = 'enrich:unconfirmed';
      row.liveness_reason = `Listing URL re-sourced: ${owner.reason}`;
      row.livenessReason = row.liveness_reason;
      mappingLivenessStatus = 'unconfirmed';
      checkedAt = null;
      changes.push('listing_url_resourced');
      reasons.push(owner.reason);
    } else if (record) {
      const status = typeof record.status === 'string' ? record.status : null;
      const reason = typeof record.reason === 'string' ? record.reason : null;
      if (row.liveness_status !== status || row.liveness_reason !== reason || row.liveness_code !== (status ? `enrich:${status}` : null)) {
        changes.push('liveness_copied');
      }
      row.liveness_status = status;
      row.livenessStatus = status;
      row.liveness_reason = reason;
      row.livenessReason = reason;
      row.liveness_code = status ? `enrich:${status}` : null;
      row.livenessCode = row.liveness_code;
      if (reason) reasons.push(`Liveness: ${reason}`);

      const existingDescription = String(row.description ?? row.jobDescription ?? row.job_description ?? '');
      if (existingDescription.length < 120) {
        const verified = verifyDescription(liveDir, sourceId, record);
        if (verified.ok) {
          row.description = verified.text;
          row.jobDescription = undefined;
          row.job_description = undefined;
          changes.push('description_filled');
          descriptionDigest = verified.digest;
          const normalized = contractText(verified.text);
          if (normalized !== verified.text) storedDescriptionDigest = sha256(Buffer.from(normalized, 'utf8'));
          reasons.push('Filled description from a verified active liveness capture');
        } else {
          descriptionFailure = verified.reason;
          reasons.push(`description_unverified: ${verified.reason}`);
        }
      }
    }

    if (!isResourced) {
      let identity;
      try { identity = candidateIdentityMetadata(row); } catch (error) {
        if (owner && Object.hasOwn(owner, 'apply_url')) {
          throw new Error(`Override for ${sourceId} conflicts with the record identity: ${error.message}`);
        }
        throw error;
      }
      const portalCompany = companyForCandidate(identity);
      if (portalCompany && row.company !== portalCompany) {
        row.company = portalCompany;
        changes.push('company_from_portals');
        reasons.push(`Company name matched portals.yml: ${portalCompany}`);
      }
    }

    if (owner && Object.hasOwn(owner, 'apply_url')) {
      row.apply_url = owner.apply_url;
      row.applyUrl = undefined;
      changes.push('apply_url_override');
      reasons.push(owner.reason);
    }
    if (owner && Object.hasOwn(owner, 'company')) {
      if (row.company !== owner.company) changes.push('company_override');
      row.company = owner.company;
      reasons.push(owner.reason);
    }

    let normalized;
    try {
      normalized = normalizeCanonicalCandidate(row, {
        runId: outRunId,
        inputName: 'enrich-run',
        index,
        createdAt,
      });
    } catch (error) {
      if (owner && Object.hasOwn(owner, 'apply_url')) {
        throw new Error(`Override for ${sourceId} conflicts with the record identity: ${error.message}`);
      }
      throw error;
    }
    if (!normalized) throw new Error(`Source candidate ${sourceId} cannot be normalized by the scan contract`);
    if (normalized.candidate_id !== sourceId) changes.push('candidate_id_changed');
    transformed.push(row);
    sourceMetadata.push({
      source_candidate_id: sourceId,
      candidate_id: normalized.candidate_id,
      status: descriptionFailure ? 'description_unverified' : changes.length ? 'enriched' : record ? 'unchanged' : 'no_liveness',
      changes,
      reason: reasons.join('; ') || (record ? 'No enrichment changes were needed' : 'No liveness entry was available'),
      previous_listing_url: isResourced ? previousListingUrl : null,
      previous_ats_identity: isResourced && Object.keys(previousAtsIdentity).length ? previousAtsIdentity : null,
      liveness_status: mappingLivenessStatus,
      liveness_checked_at: checkedAt,
      ...(descriptionDigest ? { description_sha256: descriptionDigest } : {}),
      ...(storedDescriptionDigest ? { stored_description_sha256: storedDescriptionDigest } : {}),
    });
  }

  const inputs = [{ name: 'enrich-run', rows: transformed }];
  const derivedFrom = sourceRunId;
  const metadataBase = {
    tool: 'enrich-run',
    derived_from: derivedFrom,
    liveness_dir: liveDir,
    liveness_sha256: sha256(liveness.bytes),
    overrides_sha256: overridesHash,
  };
  const built = buildImmutableScanRun({
    root: projectRoot,
    runId: outRunId,
    inputs,
    createdAt,
    sourceArchitecture: 'enrich-run',
    metadata: metadataBase,
    locationPriority: [],
  });
  const outputIds = new Set(built.candidates.map((candidate) => candidate.candidate_id));
  for (const entry of sourceMetadata) {
    if (!outputIds.has(entry.candidate_id)) {
      throw new Error(`Enrichment mapping for ${entry.source_candidate_id} does not match built candidate IDs`);
    }
  }
  const counts = new Map();
  for (const entry of sourceMetadata) counts.set(entry.candidate_id, (counts.get(entry.candidate_id) || 0) + 1);
  for (const entry of sourceMetadata) {
    if ((counts.get(entry.candidate_id) || 0) > 1) {
      entry.status = 'converged';
      entry.converged = true;
      entry.changes = [...new Set([...entry.changes, 'converged'])];
      entry.reason = `${entry.reason}; multiple source candidates converged on one candidate_id`;
    }
  }
  const enrichmentContent = `${JSON.stringify(sourceMetadata, null, 2)}\n`;
  const enrichmentHash = sha256(Buffer.from(enrichmentContent, 'utf8'));
  const metadata = { ...metadataBase, enrichment_sha256: enrichmentHash };
  const finalBuilt = buildImmutableScanRun({
    root: projectRoot,
    runId: outRunId,
    inputs,
    createdAt,
    sourceArchitecture: 'enrich-run',
    metadata,
    locationPriority: [],
  });
  if (JSON.stringify(finalBuilt.candidates) !== JSON.stringify(built.candidates)) {
    throw new Error('Scan contract candidates changed while binding enrichment.json hash');
  }
  const preview = previewFrom(sourceMetadata, source.candidates, finalBuilt.candidates);
  return {
    root: projectRoot,
    runId: outRunId,
    sourceRunId,
    runDir: targetDir,
    createdAt,
    inputs,
    metadata,
    candidates: finalBuilt.candidates,
    enrichment: sourceMetadata,
    enrichmentContent,
    warnings,
    stagingDirs,
    preview,
    sourceDir,
    livenessDir: liveDir,
  };
}

/** Enrich a run or return an identical no-write plan for --dry-run. */
export async function enrichRun(options = {}) {
  const plan = await planEnrichment(options);
  if (options.dryRun) return { ...plan, dryRun: true, written: false };
  const written = writeImmutableScanRun({
    root: plan.root,
    outRoot: 'output/scan-runs',
    runId: plan.runId,
    inputs: plan.inputs,
    createdAt: plan.createdAt,
    sourceArchitecture: 'enrich-run',
    metadata: plan.metadata,
    locationPriority: [],
    extraFiles: { 'enrichment.json': plan.enrichmentContent },
  });
  if (JSON.stringify(written.candidates) !== JSON.stringify(plan.candidates)) {
    throw new Error('Published scan candidates differ from the hash-bound enrichment plan');
  }
  return { ...plan, ...written, dryRun: false, written: true };
}

export function parseArgs(argv) {
  const options = { runDir: '', livenessDir: '', outRunId: '', overridesPath: null, root: process.cwd(), dryRun: false, json: false };
  const seen = new Set();
  const valueFlags = new Map([
    ['--run', 'runDir'], ['--liveness', 'livenessDir'], ['--out-run', 'outRunId'],
    ['--overrides', 'overridesPath'], ['--root', 'root'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { ...options, help: true };
    if (flag === '--dry-run' || flag === '--json') {
      const key = flag === '--dry-run' ? 'dryRun' : 'json';
      if (options[key]) throw new Error(`Duplicate flag: ${flag}`);
      options[key] = true;
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`Unknown flag: ${flag}`);
    if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    seen.add(flag);
    options[key] = value;
  }
  for (const [flag, key] of [['--run', 'runDir'], ['--liveness', 'livenessDir'], ['--out-run', 'outRunId']]) {
    if (!options[key]) throw new Error(`Missing required ${flag}`);
  }
  return options;
}

export function enrichHelp() {
  return [
    'Usage: node enrich-run.mjs --run <source-run-dir> --liveness <liveness-out-dir> --out-run <new-run-id>',
    '       [--overrides <file.json>] [--dry-run] [--json] [--root <project-root>]',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    console.error(`${error.message}\n\n${enrichHelp()}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(enrichHelp());
    return;
  }
  try {
    const result = await enrichRun(options);
    if (options.json) {
      console.log(JSON.stringify({
        run_id: result.runId,
        source_run_id: result.sourceRunId,
        output_dir: result.runDir,
        dry_run: result.dryRun,
        written: result.written,
        preview: result.preview,
        warnings: result.warnings,
      }, null, 2));
    } else {
      for (const warning of result.warnings) console.warn(`Warning: ${warning}`);
      console.log(`${result.dryRun ? 'Dry run' : 'Wrote'} ${result.preview.output_candidates} candidate(s) to ${result.runDir}`);
      if (result.preview.convergences.length) console.log(`Converged source candidates: ${JSON.stringify(result.preview.convergences)}`);
    }
  } catch (error) {
    console.error(`Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
