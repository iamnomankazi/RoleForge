import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const SOURCE_ROOT = resolve(import.meta.dirname, '..');

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function putJson(file, value) {
  put(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** Build a self-contained career-ops tree from a compact fixture description. */
export function createWorkTreeFixture(description = {}) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-worklist-'));
  put(join(root, 'templates', 'states.yml'), readFileSync(join(SOURCE_ROOT, 'templates', 'states.yml')));
  put(join(root, 'applications.md'), description.tracker ?? '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');

  for (const [name, content] of Object.entries(description.reports ?? {})) put(join(root, 'reports', name), content);
  for (const [runId, run] of Object.entries(description.scanRuns ?? {})) {
    const runDir = join(root, 'output', 'scan-runs', runId);
    const manifest = structuredClone(run.manifest ?? {});
    if (run.enrichment !== undefined) {
      const bytes = typeof run.enrichment === 'string' ? run.enrichment : JSON.stringify(run.enrichment);
      if (!run.omitEnrichmentMarker) {
        manifest.metadata = { ...(manifest.metadata ?? {}), tool: 'enrich-run' };
        manifest.metadata.enrichment_sha256 = run.hash ?? createHash('sha256').update(bytes).digest('hex');
      }
      put(join(runDir, 'enrichment.json'), bytes);
    }
    putJson(join(runDir, 'manifest.json'), manifest);
    if (run.candidates !== undefined) putJson(join(runDir, 'candidates.json'), run.candidates);
  }
  for (const [name, ledger] of Object.entries(description.corrections ?? {})) putJson(join(root, 'output', 'identity-corrections', name), ledger);
  for (const [name, results] of Object.entries(description.livenessFiles ?? {})) putJson(join(root, 'output', name), results);
  for (const [batchId, batch] of Object.entries(description.batches ?? {})) {
    const manifest = batch.manifest ?? { batchId, sourceRunId: 'fixture-run', candidates: [] };
    putJson(join(root, 'output', 'application-batches', batchId, 'manifest.json'), manifest);
    if (batch.state !== undefined) putJson(join(root, 'output', 'application-batches', batchId, 'state.json'), batch.state);
  }

  return {
    root,
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export function trackerTable(rows, headers = ['#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report', 'Notes']) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return `${lines.join('\n')}\n`;
}

export function reportMarkdown({ candidateId, supersedes, summary, extra = '' } = {}) {
  const headers = [candidateId ? `**Candidate ID:** ${candidateId}` : '',
    supersedes ? `**Supersedes:** [${supersedes}](reports/${String(supersedes).padStart(3, '0')}-old.md)` : ''].filter(Boolean);
  return `${headers.join('\n')}\n\n## Machine Summary\n\n\`\`\`yaml\n${summary ?? ''}\n\`\`\`\n\n${extra}`;
}
