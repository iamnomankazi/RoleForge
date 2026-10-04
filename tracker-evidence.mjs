/** Shared, conservative identity and evidence helpers for destructive tracker operations. */

const EMPTY_EVIDENCE = new Set(['', '-', '—', 'n/a', 'na', 'none', 'null', 'pending', '❌']);
const REQ_NUMBER_RE = /\b(?:job\s*id|posting\s*id|requisition|req|jr|job|posting|ref(?:erence)?|r_)[\s:#_-]*([a-z][a-z0-9-]*\d[a-z0-9-]*|\d[a-z0-9-]*)\b/giu;

export function normalizeOpeningText(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function meaningfulEvidence(value) {
  return !EMPTY_EVIDENCE.has(normalizeOpeningText(value));
}

export function evidenceEntries(value) {
  if (!meaningfulEvidence(value)) return [];
  return String(value).split(/\s*;\s*/u).map((entry) => entry.trim()).filter(meaningfulEvidence);
}

export function unionEvidence(...values) {
  const out = [];
  const keys = new Set();
  for (const value of values) {
    for (const entry of evidenceEntries(value)) {
      const key = normalizeOpeningText(entry);
      if (!keys.has(key)) {
        keys.add(key);
        out.push(entry);
      }
    }
  }
  return out.length ? out.join('; ') : '—';
}

export function evidenceContains(container, evidence) {
  const available = new Set(evidenceEntries(container).map(normalizeOpeningText));
  return evidenceEntries(evidence).every((entry) => available.has(normalizeOpeningText(entry)));
}

export function requisitionIdentities(notes) {
  const ids = new Set();
  for (const match of String(notes ?? '').matchAll(REQ_NUMBER_RE)) ids.add(normalizeOpeningText(match[1]));
  return ids;
}

function labeledEvidence(notes, label) {
  const values = [];
  const re = new RegExp(`(?:^|;\\s*)${label}:\\s*([^;]+)`, 'giu');
  for (const match of String(notes ?? '').matchAll(re)) if (meaningfulEvidence(match[1])) values.push(match[1].trim());
  return values.join('; ');
}

export function effectiveVia(row) {
  return meaningfulEvidence(row?.via) ? row.via : labeledEvidence(row?.notes, 'Via');
}

export function effectiveLocation(row) {
  return meaningfulEvidence(row?.location) ? row.location : labeledEvidence(row?.notes, 'Location');
}

function setsIntersect(a, b) {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/** Exact destructive identity: company plus req/ATS identity, otherwise exact role. */
export function sameOpening(a, b) {
  if (!normalizeOpeningText(a?.company) || normalizeOpeningText(a?.company) !== normalizeOpeningText(b?.company)) return false;
  const reqA = requisitionIdentities(a?.notes);
  const reqB = requisitionIdentities(b?.notes);
  if (reqA.size && reqB.size) return setsIntersect(reqA, reqB) && channelsCompatible(a, b);
  return Boolean(normalizeOpeningText(a?.role))
    && normalizeOpeningText(a?.role) === normalizeOpeningText(b?.role)
    && channelsCompatible(a, b);
}

/** Distinct non-empty channels remain separate to avoid hiding duplicate submissions. */
export function channelsCompatible(a, b) {
  const viaA = new Set(evidenceEntries(effectiveVia(a)).map(normalizeOpeningText));
  const viaB = new Set(evidenceEntries(effectiveVia(b)).map(normalizeOpeningText));
  return !viaA.size || !viaB.size || setsIntersect(viaA, viaB);
}

export function appendLabeledEvidence(notes, label, value) {
  if (!meaningfulEvidence(value)) return unionEvidence(notes);
  return unionEvidence(notes, `${label}: ${value}`);
}
