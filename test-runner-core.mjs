/**
 * Pure validation helpers for the discovered node:test child process.
 * Keeping these outside test-all.mjs lets the fail-closed behavior be tested
 * without importing (and therefore running) the full suite.
 */

const TERMINATION_PATTERNS = [
  { name: 'process.exit()', re: /\bprocess\s*\.\s*exit\s*\(/ },
  { name: 'finish()', re: /(^|[^\w$.])finish\s*\(/m },
];

export function validateDiscoveredTestSources(files, readSource) {
  const violations = [];
  for (const file of files) {
    const source = readSource(file);
    for (const pattern of TERMINATION_PATTERNS) {
      if (pattern.re.test(source)) violations.push({ file, mechanism: pattern.name });
    }
  }
  return violations;
}

function lastMetric(tap, name) {
  const matches = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

export function parseTapSummary(tap, { files, exitCode }) {
  const summary = {
    files,
    cases: lastMetric(tap, 'tests'),
    passed: lastMetric(tap, 'pass'),
    failed: lastMetric(tap, 'fail'),
    skipped: lastMetric(tap, 'skipped'),
    cancelled: lastMetric(tap, 'cancelled'),
    todo: lastMetric(tap, 'todo'),
    exitCode,
  };
  const required = ['cases', 'passed', 'failed', 'skipped', 'cancelled', 'todo'];
  const missing = required.filter((key) => summary[key] === null);
  const accounted = missing.length === 0
    ? summary.passed + summary.failed + summary.skipped + summary.cancelled + summary.todo
    : null;
  const complete = missing.length === 0 && summary.cases > 0 && accounted === summary.cases;
  return { summary, complete, missing, accounted };
}

export function discoveredRunFailed(parsed) {
  return parsed.summary.exitCode !== 0
    || !parsed.complete
    || parsed.summary.failed > 0
    || parsed.summary.cancelled > 0;
}

/** Collect complete child output and settle once, after stdio has closed. */
export function collectChildOutput(child, { onStdout = () => {}, onStderr = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exitCode = null;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); onStdout(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); onStderr(chunk); });
    child.once('exit', (code) => { exitCode = code; });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? exitCode ?? 1, stdout, stderr });
    });
  });
}
