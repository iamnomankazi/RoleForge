// Static hygiene audit, not a JavaScript sandbox. Browser reads/discovery alone
// confer no application authority. Archived bytes require ignored evidence paths
// AND matching provenance; a wrapper that executes them is always live authority.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function archivedSourceMatches(root, relative, source, ignored) {
  if (!ignored || !relative.startsWith('output/')) return false;
  try {
    const index = relative.indexOf('/preimages/');
    if (index !== -1) {
      const baseline = JSON.parse(readFileSync(resolve(root, relative.slice(0, index), 'baseline.json'), 'utf8'));
      const record = (baseline.hashes || baseline.files)?.[relative.slice(index + '/preimages/'.length)];
      const expected = typeof record === 'string' ? record : record?.sha256;
      return expected === createHash('sha256').update(source).digest('hex');
    }
    const projection = '/proposed-privacy-projection/';
    const offset = relative.indexOf(projection);
    if (offset !== -1) {
      const proposal = JSON.parse(readFileSync(resolve(root, relative.slice(0, offset), 'privacy-projection-proposal.json'), 'utf8'));
      const commit = relative.slice(offset + projection.length).replace(/\.mjs$/, '');
      const blob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
      return proposal.changes?.some((change) => change.sourceCommit === commit && change.projectedBlob === blob) === true;
    }
  } catch { /* Missing or damaged provenance cannot exempt executable authority. */ }
  return false;
}

export function legacyAuthorityViolation(root, relative, source, { ignored = false } = {}) {
  if (archivedSourceMatches(root, relative, source, ignored)) return null;
  // Any executable bridge into an evidence tree makes it active, even when the
  // bridge itself contains no browser calls. Reads/hashes of evidence are fine.
  const archiveExecution = /(?:import\s*(?:\(|[^;\n]*\bfrom\s*|['"])|export\s+[^;\n]*\bfrom\s*|require\s*\(|(?:execFile(?:Sync)?|exec(?:Sync)?|spawn(?:Sync)?)\s*\()[\s\S]{0,400}(?:preimages|proposed-privacy-projection)[\\/]/.test(source);
  // Creating an inert review queue/fixture confers no execution authority.
  // Any other queue reference (read, import, configured input) stays prohibited.
  const queue = /apply-queue\.csv/.test(source.replace(/\b(?:write|writeFile(?:Sync)?)\([^;\n]*apply-queue\.csv[^;\n]*\);/g, ''));
  // Canonical modules enforce exact manifests/IDs internally and also expose
  // read-only validators used by diagnostics. Their mere import is not legacy
  // authority; audited legacy entrypoints and direct browser writes are.
  const applicationModule = /(?:\bfrom\s*['"]|\bimport\s*(?:\(\s*)?['"]|\brequire\s*\(\s*['"]|(?:execFile(?:Sync)?|spawn(?:Sync)?)\s*\()[^;\n]{0,300}(?:prepare-application|mark-applied|open-apply-batch)\.(?:mjs|cjs|js)/.test(source);
  const browserWrite = /\.(?:fill|type|setInputFiles|selectOption|check|uncheck|submit|requestSubmit)\s*\(/.test(source);
  const finalClick = /(?:submit|send|apply|complete)[^\n]{0,160}\.click\s*\(|\.click\s*\([^\n]{0,160}(?:submit|send|apply|complete)/i.test(source);
  if (!archiveExecution && !queue && !applicationModule && !browserWrite && !finalClick) return null;
  if (/Legacy application entrypoint disabled|disableLegacyApplicationEntrypoint/.test(source.slice(0, 700))) return null;
  return `${relative}: live legacy application authority must be disabled`;
}
