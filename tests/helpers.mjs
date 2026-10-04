// tests/helpers.mjs — shared assertion helpers + counters for the test suite.
// Moved verbatim from test-all.mjs (issue #1440); no framework by design:
// the suite must run on a fresh clone with only Node.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');   // repo root (tests/ lives one level down)
export const QUICK = process.argv.includes('--quick');
export const NODE = process.execPath;

let passed = 0;
let failed = 0;
let warnings = 0;

/**
 * Record and print one passing test assertion.
 *
 * The suite uses these small counters instead of a framework so it can run in
 * any freshly cloned career-ops checkout with only Node.js available.
 *
 * @param {string} msg - Human-readable success message for the terminal log.
 * @returns {void}
 */
export function pass(msg) { console.log(`  ✅ ${msg}`); passed++; }

/**
 * Record and print one failing test assertion.
 *
 * Failures increment the shared counter that controls the final process exit
 * code, while still allowing later checks to run and show the full problem set.
 *
 * @param {string} msg - Human-readable failure message for the terminal log.
 * @returns {void}
 */
export function fail(msg) { console.log(`  ❌ ${msg}`); failed++; }

/**
 * Record and print one non-fatal warning.
 *
 * Warnings are used for expected local-environment gaps, such as missing user
 * data in a clean repo, where the check should stay visible but not fail CI.
 *
 * @param {string} msg - Human-readable warning message for the terminal log.
 * @returns {void}
 */
export function warn(msg) { console.log(`  ⚠️  ${msg}`); warnings++; }

/** Current counter snapshot. */
export function results() { return { passed, failed, warnings }; }

/**
 * Print the summary line and exit with the suite's exit code.
 * Moved verbatim from the tail of test-all.mjs — output must stay byte-identical.
 */
export function finish({ nodeSummary = null, partial = false } = {}) {
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  console.log(`Legacy/core assertion count: ${passed} passed, ${failed} failed, ${warnings} warnings`);
  if (nodeSummary) {
    console.log(`node:test count: ${nodeSummary.files} files, ${nodeSummary.cases} cases, ${nodeSummary.passed} passed, ${nodeSummary.failed} failed, ${nodeSummary.skipped} skipped, ${nodeSummary.cancelled} cancelled, ${nodeSummary.todo} todo`);
  }
  console.log(`Overall failures: ${failed + (nodeSummary?.failed || 0)}${partial ? ' (partial --only run)' : ''}`);
  if (failed > 0 || (nodeSummary?.failed || 0) > 0) {
    console.log('🔴 TESTS FAILED — do NOT push/merge until fixed\n');
    process.exit(1);
  } else if (warnings > 0) {
    console.log('🟡 Tests passed with warnings — review before pushing\n');
    process.exit(0);
  } else {
    console.log('🟢 All tests passed — safe to push/merge\n');
    process.exit(0);
  }
}

const SCOOP_ROOTS = [
  process.env.SCOOP,
  process.env.USERPROFILE ? join(process.env.USERPROFILE, 'scoop') : null,
].filter(Boolean);

const WINDOWS_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ...SCOOP_ROOTS.flatMap((root) => [
    join(root, 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(root, 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
  ]),
];

const WINDOWS_CYGPATH_CANDIDATES = [
  'C:\\Program Files\\Git\\usr\\bin\\cygpath.exe',
  ...SCOOP_ROOTS.map((root) => join(root, 'apps', 'git', 'current', 'usr', 'bin', 'cygpath.exe')),
];

function resolveAllowedExecutable(cmd) {
  if (cmd === process.execPath || cmd === 'node') return process.execPath;
  if (cmd === 'bash' || cmd === 'git' || cmd === 'go' || cmd === 'wsl') return cmd;
  if (WINDOWS_BASH_CANDIDATES.includes(cmd)) return cmd;
  throw new Error(`run(): executable not in the test-helper allowlist: ${cmd}`);
}

let lastFailure = null;

/** Run an allowlisted executable with an argument vector. */
export function run(cmd, args = [], opts = {}) {
  lastFailure = null;
  const exe = resolveAllowedExecutable(cmd);
  try {
    return execFileSync(exe, args, { cwd: ROOT, encoding: 'utf-8', timeout: 30000, ...opts }).trim();
  } catch (e) {
    lastFailure = {
      status: e?.status ?? null,
      signal: e?.signal ?? null,
      stdout: e?.stdout == null ? '' : String(e.stdout),
      stderr: e?.stderr == null ? '' : String(e.stderr),
    };
    warnFallbackShell(exe);
    return null;
  }
}

export function lastRunFailure() { return lastFailure; }

export function formatRunFailure(maxChars = 2000) {
  if (!lastFailure) return '';
  const clip = (value) => {
    const text = String(value ?? '').trim();
    if (!text) return '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n    ... (${text.length - maxChars} more chars)` : text;
  };
  const parts = [` (exit ${lastFailure.status ?? 'null'}${lastFailure.signal ? `, signal ${lastFailure.signal}` : ''})`];
  const out = clip(lastFailure.stdout);
  const err = clip(lastFailure.stderr);
  if (out) parts.push(`\n    stdout: ${out.replace(/\n/g, '\n    ')}`);
  if (err) parts.push(`\n    stderr: ${err.replace(/\n/g, '\n    ')}`);
  return parts.join('');
}

/**
 * Check whether a repo-relative file exists.
 *
 * @param {string} path - Path relative to the career-ops repository root.
 * @returns {boolean} True when the file exists.
 */
export function fileExists(path) { return existsSync(join(ROOT, path)); }

let bashCache = null;
let bashSourceCache = null;

export function bashSource() { return bashSourceCache; }

const FALLBACK_BASH_SOURCES = new Set(['wsl', 'path', 'unresolved']);
let warnedFallbackShell = false;

function warnFallbackShell(exe) {
  if (warnedFallbackShell || bashCache === null || exe !== bashCache || !FALLBACK_BASH_SOURCES.has(bashSourceCache)) return;
  warnedFallbackShell = true;
  const where = {
    wsl: 'WSL bash (a different OS with its own PATH)',
    path: 'bash from PATH (provenance unknown)',
    unresolved: 'bash, which no probe could confirm exists',
  }[bashSourceCache];
  console.error(`    [shell] failed command used ${where}; Git Bash was not found at a known location.`);
  console.error('            Windows node and PATH-injected test binaries may be unavailable in that shell.');
}

/**
 * Resolve the bash executable to use for shell-script checks, lazily.
 *
 * The Windows probes below shell out up to four times (the WSL probe can even
 * boot the WSL VM). Every test file imports this module, so doing the probes
 * eagerly at module load would repeat that cost once per spawned test process.
 * Resolution therefore happens on first call and is memoized for the rest of
 * the process; suites that never touch bash never pay for it.
 *
 * @returns {string} Bash executable path or command name.
 */
export function getBash() {
  if (bashCache !== null) return bashCache;
  if (process.platform !== 'win32') { bashSourceCache = 'posix'; return (bashCache = 'bash'); }
  for (const cmd of WINDOWS_BASH_CANDIDATES) {
    try {
      execFileSync(cmd, ['-c', 'true'], { stdio: 'ignore' });
      bashSourceCache = 'git-bash';
      return (bashCache = cmd);
    } catch {}
  }
  try {
    execFileSync('wsl', ['-e', 'bash', '-c', 'true'], { stdio: 'ignore' });
    bashSourceCache = 'wsl';
    return (bashCache = 'bash');
  } catch {}
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' });
    bashSourceCache = 'path';
    return (bashCache = 'bash');
  } catch {}
  bashSourceCache = 'unresolved';
  return (bashCache = 'bash');
}

export function toBashPath(wpath) {
  if (process.platform !== 'win32') return wpath;
  const forwardSlashed = wpath.replace(/\\/g, '/');
  // Try cygpath first: it ships with Git for Windows, which is also what
  // provides `bash` on PATH on most Windows dev machines (see getBash()
  // above). cygpath emits /c/... paths that match Git Bash's mount scheme.
  // wslpath emits /mnt/c/... paths, which only resolve inside WSL's own
  // bash -- if WSL happens to be installed but `bash` on PATH still
  // resolves to Git Bash, a wslpath-first order silently produces a path
  // Git Bash can't find (see #1409). Only fall back to wslpath (and only
  // pay the cost of booting the WSL VM) when cygpath is unavailable.
  try {
    // execFileSync: the path is passed as an argv element, never interpolated
    // into a shell string, so quotes/spaces in it can't be re-parsed.
    const cygpathCmd = WINDOWS_CYGPATH_CANDIDATES.find((candidate) => existsSync(candidate)) || 'cygpath';
    const out = execFileSync(cygpathCmd, ['-u', forwardSlashed], { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch {}
  try {
    execFileSync('wsl', ['-e', 'bash', '-c', 'true'], { stdio: 'ignore' });
    const out = execFileSync('wsl', ['wslpath', '-u', forwardSlashed], { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    if (out) return out;
  } catch {}
  return wpath.replace(/^[A-Za-z]:/, m => '/' + m[0].toLowerCase()).replace(/\\/g, '/');
}

/**
 * Capture console.error output produced by an async callback.
 *
 * Several provider fetch() paths report truncation/failure via console.error;
 * their tests need to assert on those messages. This wraps the
 * save/override/restore dance in one place — console.error is restored in
 * finally, even when the callback throws, so one test's override can never
 * leak into the next.
 *
 * @param {() => Promise<any>|any} fn - Callback to run while capturing.
 * @returns {Promise<{result: any, errors: any[]}>} Callback result + captured messages.
 */
export async function captureConsoleErrors(fn) {
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    const result = await fn();
    return { result, errors };
  } finally {
    console.error = original;
  }
}
