/**
 * Salary evidence for one exact application candidate, read from records RoleForge already keeps:
 *
 *   verifiedPostingCapture: the complete posting text, when the batch's source run is an enrich-run whose
 *     enrichment record (enrichment_sha256) and liveness capture (liveness_sha256, description file hash and length)
 *     are intact, the capture is of this exact candidate's own posting URL, active, not re-sourced, and recorded by
 *     candidate-liveness.mjs as the WHOLE posting including its structured pay fields (`posting_complete`, set only
 *     for ATS APIs that return every section; scan excerpts, browser captures of one page section and older
 *     captures never count).
 *   reportCompensation: advertised_comp from evaluation reports that name this exact candidate (no company/title
 *     matching). Unreadable report files, or a report whose header and Machine Summary name different candidates,
 *     make the evidence unverified or a conflict.
 *
 * Both are inputs to salary-policy.mjs, which leaves the salary answer manual whenever either is not established.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadReportIndex } from './tracker-identity.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const unverified = (reason) => ({ complete: false, text: '', basis: null, reason });
const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The same posting address: scheme, host, path (trailing slash ignored) and query; the fragment is ignored. */
function samePostingUrl(a, b) {
  try {
    const norm = (raw) => {
      const url = new URL(raw);
      return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    };
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

export function verifiedPostingCapture({ candidatesPath, candidateId } = {}) {
  if (typeof candidateId !== 'string' || !SAFE_ID.test(candidateId)) return unverified('no exact candidate ID');
  if (typeof candidatesPath !== 'string' || !candidatesPath) return unverified('the source run is unknown');
  const runDir = dirname(candidatesPath);
  let manifest;
  try { manifest = readJson(join(runDir, 'manifest.json')); } catch { return unverified('the source run manifest cannot be read'); }
  const meta = manifest?.metadata;
  if (meta?.tool !== 'enrich-run' || typeof meta.liveness_dir !== 'string' || !/^[a-f0-9]{64}$/.test(meta.liveness_sha256 || '')) {
    return unverified('the source run is not linked to a liveness capture of the posting');
  }
  if (!/^[a-f0-9]{64}$/.test(meta.enrichment_sha256 || '')) return unverified('the source run does not record its enrichment hash');
  let enrichmentBytes;
  try { enrichmentBytes = readFileSync(join(runDir, 'enrichment.json')); } catch { return unverified('the run enrichment record cannot be read'); }
  if (sha256(enrichmentBytes) !== meta.enrichment_sha256) return unverified('the run enrichment record changed after the run was built');
  let bytes;
  try { bytes = readFileSync(join(meta.liveness_dir, 'liveness.json')); } catch { return unverified('the linked liveness capture is missing'); }
  if (sha256(bytes) !== meta.liveness_sha256) return unverified('the linked liveness capture changed after the run was built');
  let entries;
  try { entries = JSON.parse(enrichmentBytes.toString('utf8')); } catch { return unverified('the run enrichment record cannot be read'); }
  const matches = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.candidate_id === candidateId);
  if (matches.length !== 1) return unverified('the run enrichment record has no single entry for this candidate');
  const [entry] = matches;
  if ((entry.changes || []).includes('listing_url_resourced')) return unverified('the listing URL was re-sourced after the capture');
  if (entry.liveness_status !== 'active') return unverified(`the capture status is ${entry.liveness_status || 'unknown'}`);
  const sourceId = entry.source_candidate_id;
  if (typeof sourceId !== 'string' || !SAFE_ID.test(sourceId)) return unverified('the capture has no safe source candidate ID');
  let candidates;
  try { candidates = readJson(candidatesPath); } catch { return unverified('the source run candidates cannot be read'); }
  const own = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.candidate_id === candidateId);
  if (own.length !== 1 || typeof own[0].url !== 'string') return unverified('the source run has no single record of this candidate');
  let record;
  try { record = JSON.parse(bytes.toString('utf8'))?.[sourceId]; } catch { return unverified('the linked liveness capture cannot be read'); }
  if (record?.status !== 'active') return unverified('the capture is not of an active posting');
  if (!['api', 'browser'].includes(record.method) || record.description_source !== record.method) {
    return unverified('the capture does not record that its text came from the posting itself (captures made before this field existed)');
  }
  // The capture must be of this candidate's own posting, not a page another requisition redirected to.
  if (!samePostingUrl(record.final_url, own[0].url)) return unverified("the capture ended on a different address than this candidate's posting");
  if (record.posting_complete !== true) {
    return unverified(`the ${record.method} capture is not recorded as the whole posting including its pay fields`);
  }
  const file = join(meta.liveness_dir, 'descriptions', `${sourceId}.txt`);
  if (!existsSync(file)) return unverified('the captured posting text is missing');
  const stored = readFileSync(file, 'utf8');
  if (!stored.endsWith('\n')) return unverified('the captured posting text is incomplete');
  const text = stored.slice(0, -1);
  if (sha256(Buffer.from(text, 'utf8')) !== record.description_sha256 || text.length !== record.description_chars) {
    return unverified('the captured posting text does not match its recorded hash');
  }
  let host = '';
  try { host = new URL(record.final_url).hostname; } catch { /* identity already checked */ }
  return { complete: true, text, basis: `${record.method} capture of ${host || 'the posting'} at ${record.checked_at}`, reason: null };
}

// Index warnings meaning some report could not be read at all: any of them might have named this candidate.
const UNREADABLE_REPORTS = /^(?:Could not read reports directory|Could not parse report)/;

export function reportCompensationFor(candidateId, { reportsDir } = {}) {
  if (typeof candidateId !== 'string' || !candidateId) return { status: 'unverified', values: [], reason: 'no exact candidate ID' };
  const index = loadReportIndex(reportsDir);
  if ((index.warnings || []).some((warning) => UNREADABLE_REPORTS.test(String(warning))) || (index.duplicateNumbers || []).length) {
    return { status: 'unverified', values: [], reason: 'some evaluation reports could not be read' };
  }
  const values = [];
  let found = false;
  for (const [number, report] of index) {
    const summary = report.summary;
    const summaryId = summary?.candidate_id ?? summary?.candidateId;
    if (report.candidateId !== candidateId && summaryId !== candidateId) continue;
    found = true;
    // A report naming this candidate in only one of its header and Machine Summary is contradictory evidence.
    if (report.candidateId !== candidateId || (summaryId && summaryId !== candidateId)) {
      return { status: 'conflict', values: [], reason: `report ${number} names different candidates in its header and Machine Summary` };
    }
    // An older ("legacy") summary layout still carries advertised_comp; only a missing or unparseable one is unreadable.
    if (!summary || (Array.isArray(summary.errors) && summary.errors.length) || !Object.hasOwn(summary, 'advertised_comp')) {
      return { status: 'conflict', values: [], reason: `report ${number} has no readable Machine Summary for this candidate` };
    }
    const advertised = summary.advertised_comp;
    if (advertised !== null && advertised !== undefined && String(advertised).trim()) values.push({ report: number, value: String(advertised) });
  }
  return { status: found ? 'matched' : 'none', values, reason: null };
}
