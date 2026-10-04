import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeTextKey, isSeparatorRow } from '../tracker-parse.mjs';
import { normalizeCompany } from '../tracker-utils.mjs';
import { roleTokens } from '../role-matcher.mjs';
import { fingerprintText, findCrossListings } from '../fingerprint-core.mjs';

const ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const HEADER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
`;

function sandbox(tracker = HEADER) {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-tracker-core-'));
  const trackerPath = join(dir, 'applications.md');
  const additions = join(dir, 'tracker-additions');
  const reports = join(dir, 'reports');
  mkdirSync(additions);
  mkdirSync(reports);
  writeFileSync(trackerPath, tracker);
  return {
    dir,
    tracker: trackerPath,
    additions,
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: trackerPath,
      CAREER_OPS_ADDITIONS: additions,
      CAREER_OPS_REPORTS: reports,
      CAREER_OPS_TRACKER_LOCK: join(dir, 'career-ops-merge-tracker-test.lock'),
    },
  };
}

function run(script, args, sb) {
  try {
    const stdout = execFileSync(process.execPath, [join(ROOT, script), ...args], {
      cwd: ROOT,
      env: sb.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function rowFor(content, company) {
  return content.split(/\r?\n/).find((line) => line.startsWith('|') && line.includes(`| ${company} |`));
}

test('Unicode keys preserve non-Latin company identity and NFKC equivalence', () => {
  assert.equal(normalizeTextKey('ＡＣＭＥ Oy'), 'acmeoy');
  assert.equal(normalizeCompany('株式会社ミライ'), '株式会社ミライ');
  assert.notEqual(normalizeCompany('株式会社ミライ'), normalizeCompany('株式会社未来'));
});

test('separator recognition is structural and CI/CD is one specialty token', () => {
  assert.equal(isSeparatorRow('|---|------|:---:|'), true);
  assert.equal(isSeparatorRow('| 7 | Acme | URL senior-engineer---platform |'), false);
  assert.ok(roleTokens('Senior CI/CD Platform Engineer').includes('cicd'));
});

test('fingerprint company comparison is Unicode-stable', () => {
  const body = Array.from({ length: 35 }, (_, i) => `要件 ${i} reliable platform observability delivery`).join(' ');
  const fp = fingerprintText(body);
  const history = [{ url: 'old', dateStr: '2026-08-01', company: '株式会社ミライ', title: 'Engineer', fingerprint: fp }];
  assert.equal(findCrossListings([{ url: 'same', company: '株式会社ミライ', title: 'Engineer', fingerprint: fp }], history, { today: '2026-08-07' }).length, 0);
  assert.equal(findCrossListings([{ url: 'other', company: '株式会社未来', title: 'Engineer', fingerprint: fp }], history, { today: '2026-08-07' }).length, 1);
});

test('same-run merge keeps distinct roles, refreshes upgrades, and preserves notes', () => {
  const sb = sandbox(`${HEADER}| 1 | 2026-08-01 | Ακμή | CI/CD Platform Engineer | 3.0/5 | Evaluated | ❌ | [1](reports/001-akmi.md) | original evidence |\n`);
  try {
    writeFileSync(join(sb.additions, '1-upgrade.tsv'), '1\t2026-08-02\tΑκμή\tSenior CI/CD Platform Engineer\tEvaluated\t4.2/5\t✅\t[1](reports/001-akmi.md)\tnew evidence\n');
    writeFileSync(join(sb.additions, '2-payments.tsv'), '2\t2026-08-03\t公司\tBackend Engineer Payments\tEvaluated\t3.5/5\t❌\t—\tpayments note\n');
    writeFileSync(join(sb.additions, '2-identity.tsv'), '2\t2026-08-03\t公司\tBackend Engineer Identity\tEvaluated\t3.7/5\t❌\t—\tidentity note\n');
    writeFileSync(join(sb.additions, '3-identity-upgrade.tsv'), '3\t2026-08-04\t公司\tBackend Engineer Identity\tEvaluated\t4.1/5\t❌\t—\tidentity follow-up\n');
    const result = run('merge-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.match(rowFor(content, 'Ακμή'), /original evidence\. Re-eval .*: new evidence/);
    assert.match(rowFor(content, 'Ακμή'), /Senior CI\/CD Platform Engineer/);
    assert.equal((content.match(/\| 公司 \|/g) || []).length, 2);
    assert.match(rowFor(content, '公司') || '', /Payments|Identity/);
    assert.match(content, /identity note\. Re-eval .*: identity follow-up/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('pre-existing tracker-number collision cannot merge a different role', () => {
  const sb = sandbox(`${HEADER}| 1 | 2026-08-01 | Acme | Data Engineer | 4.0/5 | Evaluated | ❌ | [10](reports/010-data.md) | Req DATA-10 |\n`);
  try {
    writeFileSync(join(sb.additions, '1-backend.tsv'), '1\t2026-08-02\tAcme\tBackend Engineer\tEvaluated\t4.2/5\t❌\t—\tReq BACK-20\n');
    const result = run('merge-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.equal((content.match(/\| Acme \|/g) || []).length, 2);
    assert.match(content, /\| 1 \|[^\n]+\| Acme \| Data Engineer \|/);
    assert.match(content, /\| 2 \|[^\n]+\| Acme \| Backend Engineer \|/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('merge keeps conflicting report and requisition identities separate', () => {
  const sb = sandbox(`${HEADER}| 1 | 2026-08-01 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [21](reports/021-a.md) | Req ENG-21 |\n`);
  try {
    writeFileSync(join(sb.additions, '1-conflict.tsv'), '1\t2026-08-02\tAcme\tEngineer\tEvaluated\t4.2/5\t❌\t[22](reports/022-b.md)\tReq ENG-22\n');
    const result = run('merge-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.equal((content.match(/\| Acme \| Engineer \|/g) || []).length, 2);
    assert.match(content, /\| 1 \|[^\n]+\[21\]\(reports\/021-a\.md\)/);
    assert.match(content, /\| 2 \|[^\n]+\[22\]\(reports\/022-b\.md\)/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('merge reconciles notes and complementary evidence independently of score', () => {
  const tracker = `# Applications Tracker

| # | Date | Company | Via | Role | Location | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|----------|-------|--------|-----|--------|-------|
| 1 | 2026-08-01 | LowCo | Direct | Engineer | Helsinki | 4.5/5 | Interview | [CV](output/low.pdf) | [11](reports/011-low.md) | original |
| 2 | 2026-08-01 | EqualCo | — | Engineer | — | 4.0/5 | Evaluated | — | — | baseline |
| 3 | 2026-08-01 | HighCo | Direct | Engineer | Tampere | 3.0/5 | Responded | [CV](output/high.pdf) | [13](reports/013-high.md) | existing |
`;
  const sb = sandbox(tracker);
  try {
    writeFileSync(join(sb.additions, '1-low.tsv'), '1\t2026-08-02\tLowCo\tEngineer\tEvaluated\t3.5/5\t—\t[11](reports/011-low.md)\tnew lower-score note\tlocation=—\tvia=Direct\n');
    writeFileSync(join(sb.additions, '2-equal.tsv'), '2\t2026-08-02\tEqualCo\tEngineer\tInterview\t4.0/5\t[PDF](output/equal.pdf)\t[12](reports/012-equal.md)\tequal-score report evidence\tEspoo\tvia=Referral\n');
    writeFileSync(join(sb.additions, '3-high.tsv'), '3\t2026-08-03\tHighCo\tEngineer\tEvaluated\t4.8/5\t—\t—\thigher score placeholder report\tlocation=—\tvia=Direct\n');
    const result = run('merge-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    const low = rowFor(content, 'LowCo') || '';
    const equal = rowFor(content, 'EqualCo') || '';
    const high = rowFor(content, 'HighCo') || '';
    assert.match(low, /new lower-score note/);
    assert.match(low, /\| 4\.5\/5 \| Interview \| \[CV\]/);
    assert.match(equal, /\| Referral \| Engineer \| Espoo \| 4\.0\/5 \| Interview \| \[PDF\]\(output\/equal\.pdf\) \| \[12\]/);
    assert.match(high, /\| 4\.8\/5 \| Responded \| \[CV\]\(output\/high\.pdf\) \| \[13\]/);
    assert.equal(readFileSync(join(sb.additions, 'merged', '1-low.tsv'), 'utf8').includes('new lower-score note'), true);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('missing separator and malformed additions fail without consuming evidence', () => {
  const missingSeparator = sandbox('# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n');
  try {
    const before = readFileSync(missingSeparator.tracker, 'utf8');
    const pending = join(missingSeparator.additions, '1-acme.tsv');
    writeFileSync(pending, '1\t2026-08-01\tAcme\tEngineer\tEvaluated\t4.0/5\t❌\t—\tnote\n');
    const result = run('merge-tracker.mjs', [], missingSeparator);
    assert.equal(result.code, 1);
    assert.equal(readFileSync(missingSeparator.tracker, 'utf8'), before);
    assert.equal(existsSync(pending), true);
  } finally {
    rmSync(missingSeparator.dir, { recursive: true, force: true });
  }

  const malformed = sandbox();
  try {
    const pending = join(malformed.additions, 'bad.tsv');
    writeFileSync(pending, 'not\tenough\tfields\n');
    const result = run('merge-tracker.mjs', [], malformed);
    assert.equal(result.code, 1);
    assert.equal(existsSync(pending), true);
  } finally {
    rmSync(malformed.dir, { recursive: true, force: true });
  }
});

test('dedup preserves Unicode Via channels, strongest status, and all notes', () => {
  const tracker = `${HEADER.replace('| Company |', '| Company | Via |').replace('|---|------|', '|---|------|').replace('|---|------|---------|------|', '|---|------|---------|-----|------|')}`
    + '| 1 | 2026-08-01 | ? | リクルート | Platform Engineer | 4.0/5 | Evaluated | ❌ | [10](reports/010-a.md) | first note |\n'
    + '| 2 | 2026-08-02 | ? | リクルート | Platform Engineer | 3.8/5 | Hired | ❌ | [10](reports/010-a.md) | hired note |\n'
    + '| 3 | 2026-08-02 | ? | パーソル | Platform Engineer | 4.5/5 | Evaluated | ❌ | [11](reports/011-b.md) | other agency |\n';
  const sb = sandbox(tracker);
  try {
    const result = run('dedup-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.equal((content.match(/Platform Engineer/g) || []).length, 2);
    assert.match(content, /Hired/);
    assert.match(content, /first note; hired note/);
    assert.match(content, /パーソル/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('dedup preserves complementary report and PDF before removing a row', () => {
  const tracker = `${HEADER}`
    + '| 1 | 2026-08-01 | Acme | Platform Engineer | 4.8/5 | Evaluated | — | — | keeper note |\n'
    + '| 2 | 2026-08-02 | Acme | Platform Engineer | 4.0/5 | Evaluated | [CV](output/acme.pdf) | [20](reports/020-acme.md) | evidence note |\n';
  const sb = sandbox(tracker);
  try {
    const result = run('dedup-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.equal((content.match(/Platform Engineer/g) || []).length, 1);
    assert.match(content, /\| Evaluated \| \[CV\]\(output\/acme\.pdf\) \| \[20\]\(reports\/020-acme\.md\) \| keeper note; evidence note \|/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('dedup keeps conflicting report and requisition identities separate', () => {
  const tracker = `${HEADER}`
    + '| 1 | 2026-08-01 | Acme | Engineer | 4.8/5 | Evaluated | ❌ | [21](reports/021-a.md) | Req ENG-21 |\n'
    + '| 2 | 2026-08-02 | Acme | Engineer | 4.0/5 | Evaluated | ❌ | [22](reports/022-b.md) | Req ENG-22 |\n'
    + '| 3 | 2026-08-03 | Beta | Analyst | 4.2/5 | Evaluated | ❌ | — | Req ANA-1 |\n'
    + '| 4 | 2026-08-04 | Beta | Analyst | 3.9/5 | Evaluated | ❌ | — | Req ANA-2 |\n';
  const sb = sandbox(tracker);
  try {
    const result = run('dedup-tracker.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.equal((content.match(/\| Acme \| Engineer \|/g) || []).length, 2);
    assert.equal((content.match(/\| Beta \| Analyst \|/g) || []).length, 2);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('explicit row/report selectors resolve divergent and report-less IDs safely', () => {
  const sb = sandbox(`${HEADER}| 2 | 2026-08-01 | RowCo | Engineer | 4.0/5 | Evaluated | ❌ | — | row only |\n| 8 | 2026-08-02 | ReportCo | Manager | 4.1/5 | Evaluated | ❌ | [2](reports/002-report.md) | report row |\n`);
  try {
    assert.equal(run('set-status.mjs', ['2', 'Interview'], sb).code, 3);
    assert.equal(run('set-status.mjs', ['--row', '2', 'Interview'], sb).code, 0);
    assert.equal(run('set-status.mjs', ['--report', '2', 'Responded'], sb).code, 0);
    const content = readFileSync(sb.tracker, 'utf8');
    assert.match(rowFor(content, 'RowCo'), /\| Interview \|/);
    assert.match(rowFor(content, 'ReportCo'), /\| Responded \|/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('status normalization follows a reordered header without touching score', () => {
  const tracker = `# Applications Tracker

| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |
|---|------|---------|------|----------|-------|--------|-----|--------|-------|
| 1 | 2026-08-01 | Acme | Engineer | Helsinki | — | Aplicado | ❌ | — | note |
`;
  const sb = sandbox(tracker);
  try {
    const result = run('normalize-statuses.mjs', [], sb);
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(sb.tracker, 'utf8'), /\| Helsinki \| — \| Applied \|/);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
