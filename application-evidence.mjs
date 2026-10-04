import { createHash } from 'node:crypto';

export const APPLICATION_NARRATIVE_PROVENANCE_SCHEMA_VERSION = 1;

export const APPLICATION_EVIDENCE_CLASSES = Object.freeze({
  cv: 'factual',
  structured_profile: 'factual',
  configured_narrative_evidence: 'factual_after_validation',
  voice_dna: 'style',
  answer_bank: 'draft_reuse',
  prior_answer: 'draft_reuse',
  article_digest: 'context_rules',
  profile_mode: 'context_rules',
  job_description: 'context_rules',
  candidate_metadata: 'context_rules',
});

const FACTUAL_SOURCE_TYPES = new Set(['cv', 'structured_profile']);
const STRUCTURED_PROFILE_ROOTS = new Set([
  'candidate', 'location', 'current_status', 'compensation', 'education_details',
]);
const UNSAFE_LOCATOR = /(?:^|[.\\/])\.\.(?:[.\\/]|$)|[\\/]|\0|%2e|%2f|%5c/i;

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

function clean(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function classifyApplicationEvidenceSource(sourceType) {
  return APPLICATION_EVIDENCE_CLASSES[String(sourceType || '').trim()] || 'unsupported';
}

function assertSafeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('Narrative evidence provenance entry must be an object');
  const allowed = new Set(['sourceType', 'source', 'locator']);
  for (const key of Object.keys(spec)) {
    if (!allowed.has(key)) throw new Error(`Unsupported narrative evidence provenance field: ${key}`);
  }
  const sourceType = String(spec.sourceType || spec.source || '').trim();
  if (!FACTUAL_SOURCE_TYPES.has(sourceType)) {
    const sourceClass = classifyApplicationEvidenceSource(sourceType);
    throw new Error(`Narrative evidence source is not factual: ${sourceType || '(missing)'} (${sourceClass})`);
  }
  const locator = String(spec.locator || '').trim();
  if (!locator || UNSAFE_LOCATOR.test(locator)) throw new Error(`Unsafe narrative evidence locator: ${locator || '(missing)'}`);
  return { sourceType, locator };
}

function resolveCv(profile, locator) {
  const match = /^lines:(\d+)(?:-(\d+))?$/.exec(locator);
  if (!match) throw new Error(`CV evidence locator must use lines:N or lines:N-M: ${locator}`);
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start > 100) {
    throw new Error(`Invalid CV evidence line range: ${locator}`);
  }
  const lines = String(profile?.cvText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (end > lines.length) throw new Error(`CV evidence locator is out of range: ${locator}`);
  const text = clean(lines.slice(start - 1, end).join(' ').replace(/^#{1,6}\s+/, ''));
  if (!text) throw new Error(`CV evidence locator resolves to empty content: ${locator}`);
  return text;
}

function resolveStructuredProfile(profile, locator) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(locator)) {
    throw new Error(`Invalid structured-profile evidence locator: ${locator}`);
  }
  const parts = locator.split('.');
  if (!STRUCTURED_PROFILE_ROOTS.has(parts[0])) throw new Error(`Structured-profile evidence root is not allowed: ${parts[0]}`);
  if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new Error(`Unsafe structured-profile evidence locator: ${locator}`);
  }
  let value = profile?.raw;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) {
      throw new Error(`Structured-profile evidence locator is unresolved: ${locator}`);
    }
    value = value[part];
  }
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`Structured-profile evidence locator must resolve to a scalar: ${locator}`);
  }
  const text = clean(value);
  if (!text) throw new Error(`Structured-profile evidence locator resolves to empty content: ${locator}`);
  return text;
}

export function resolveFactualEvidence(profile, spec) {
  const { sourceType, locator } = assertSafeSpec(spec);
  const fileKey = sourceType === 'cv' ? 'cv' : 'profile';
  const source = profile?.sourceFiles?.[fileKey];
  if (!source || !/^sha256:[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.size)) {
    throw new Error(`Current factual source binding is unavailable: ${sourceType}`);
  }
  const text = sourceType === 'cv' ? resolveCv(profile, locator) : resolveStructuredProfile(profile, locator);
  return {
    sourceClass: 'factual',
    sourceType,
    sourceId: sourceType === 'cv' ? 'cv.md' : 'config/profile.yml',
    sourceHash: source.sha256,
    sourceSize: source.size,
    locator,
    evidenceIdentity: `${sourceType}:${locator}`,
    evidenceHash: sha256(text),
    text,
  };
}

export function resolveConfiguredNarrativeEvidence(profile, requestedTopics) {
  const entries = Array.isArray(profile?.formRules?.narrative_evidence)
    ? profile.formRules.narrative_evidence
    : [];
  const selected = entries.filter((entry) => (entry?.topics || []).some((topic) => requestedTopics.has(clean(topic).toLowerCase().replace(/\s+/g, '_'))));
  if (!selected.length) throw new Error(`Missing evidence for requested narrative topics: ${[...requestedTopics].join(', ')}`);
  const resolved = [];
  for (const entry of selected) {
    const identity = clean(entry?.id);
    if (!identity) throw new Error('Configured narrative evidence is missing a stable id');
    if (entry.text || entry.evidence_refs || entry.evidenceRefs) {
      throw new Error(`Configured narrative evidence ${identity} uses legacy unproven prose; add factual provenance`);
    }
    if (!Array.isArray(entry.provenance) || entry.provenance.length === 0) {
      throw new Error(`Configured narrative evidence ${identity} has no factual provenance`);
    }
    for (const spec of entry.provenance) {
      const evidence = resolveFactualEvidence(profile, spec);
      resolved.push({ ...evidence, configuredEvidenceId: identity });
    }
  }
  const unique = new Map(resolved.map((item) => [item.evidenceIdentity, item]));
  return [...unique.values()];
}

export function publicFactualEvidence(evidence) {
  const { text: _text, ...record } = evidence;
  return record;
}

export function revalidateFactualEvidence(profile, records) {
  if (!Array.isArray(records) || records.length === 0) throw new Error('Narrative provenance has no factual sources');
  return records.map((record) => {
    if (record?.sourceClass !== 'factual') throw new Error('Narrative provenance contains a non-factual source');
    const current = resolveFactualEvidence(profile, { sourceType: record.sourceType, locator: record.locator });
    for (const key of ['sourceId', 'sourceHash', 'sourceSize', 'evidenceIdentity', 'evidenceHash']) {
      if (record[key] !== current[key]) throw new Error(`Narrative provenance is stale or mismatched at ${record.evidenceIdentity || record.locator}: ${key}`);
    }
    return current;
  });
}

export function createNarrativeProvenanceRecord({ candidateId, normalizedQuestion, answer, wording, templateId, factualEvidence }) {
  if (!['generated', 'reused'].includes(wording)) throw new Error(`Invalid narrative wording type: ${wording}`);
  if (!clean(candidateId) || !clean(normalizedQuestion)) throw new Error('Narrative provenance requires an exact candidate and normalized question');
  if (!clean(templateId)) throw new Error('Narrative provenance requires a deterministic template identity');
  if (!Array.isArray(factualEvidence) || factualEvidence.length === 0) throw new Error('Narrative provenance requires factual evidence');
  return {
    schemaVersion: APPLICATION_NARRATIVE_PROVENANCE_SCHEMA_VERSION,
    candidateId: clean(candidateId),
    normalizedQuestion: clean(normalizedQuestion),
    answerHash: sha256(clean(answer)),
    wording,
    templateId,
    factualSources: factualEvidence.map(publicFactualEvidence),
  };
}

export function validateNarrativeProvenanceRecord(profile, record, { candidateId, normalizedQuestion, answer } = {}) {
  if (!record || record.schemaVersion !== APPLICATION_NARRATIVE_PROVENANCE_SCHEMA_VERSION) throw new Error('Narrative provenance schema is missing or unsupported');
  if (record.candidateId !== clean(candidateId) || record.normalizedQuestion !== clean(normalizedQuestion)) {
    throw new Error('Narrative provenance does not match the exact candidate and question');
  }
  if (!['generated', 'reused'].includes(record.wording)) throw new Error('Narrative provenance wording type is invalid');
  if (!clean(record.templateId)) throw new Error('Narrative provenance template identity is missing');
  if (record.answerHash !== sha256(clean(answer))) throw new Error('Narrative answer hash does not match its provenance');
  return revalidateFactualEvidence(profile, record.factualSources);
}
