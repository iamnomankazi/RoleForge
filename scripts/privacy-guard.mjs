#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Keep this copy synchronized with update-system.mjs. tests/privacy-guard.test.mjs
// checks that every user-layer entry remains represented here.
const USER_PATHS = [
  'cv.md',
  'config/profile.yml',
  'modes/_profile.md',
  'modes/_custom.md',
  'voice-dna.md',
  'portals.yml',
  'article-digest.md',
  'interview-prep/',
  'data/',
  'data/cv-claim-anchors.json',
  'reports/',
  'output/',
  'jds/',
  'writing-samples/',
  'config/plugins.yml',
  'plugins.local/',
  'plugins.lock',
  '.claude/settings.json',
  '.claude/hooks/',
  'plan/',
  'local/',
  'backups/',
  'HANDOFF.md',
  'CLAUDE.local.md',
];

const HARD_CATEGORIES = new Set(['email', 'phone', 'address', 'id_number', 'date_of_birth', 'name']);
const SOFT_CATEGORIES = new Set(['company', 'person', 'name']);
const FIX_COMMAND = 'node scripts/privacy-guard.mjs --build-denylist';
const PRIVATE_KEY_RE = /address|street|postal|zip|birth|dob|passport|permit|residence_permit|ssn|personal_id|id_number|national_id/i;
const PHONE_KEY_RE = /phone|mobile|telephone|tel(?:ephone)?_?number/i;
const EMAIL_KEY_RE = /e[-_ ]?mail/i;
const ACCEPTED_STATUSES = new Set(['applied', 'responded', 'interview', 'offer', 'rejected', 'hired']);

function git(repo, args, input = undefined, allowOne = false) {
  const result = spawnSync('git', args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !(allowOne && result.status === 1))) {
    throw new Error('git operation failed');
  }
  return { stdout: result.stdout ?? '', status: result.status ?? 1 };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function normalizeRepoPath(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function decodeGitQuoted(value) {
  if (!value.startsWith('"')) return value;
  let output = '';
  for (let i = 1; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '"') return output;
    if (ch !== '\\') {
      output += ch;
      continue;
    }
    i += 1;
    const escaped = value[i];
    const octal = value.slice(i).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      output += String.fromCharCode(parseInt(octal, 8));
      i += octal.length - 1;
    } else {
      output += ({ t: '\t', n: '\n', r: '\r', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"' })[escaped] ?? escaped;
    }
  }
  return output;
}

function readGitToken(value) {
  const input = value.trimStart();
  if (input.startsWith('"')) {
    let escaped = false;
    for (let i = 1; i < input.length; i += 1) {
      if (!escaped && input[i] === '"') {
        return { token: decodeGitQuoted(input.slice(0, i + 1)), rest: input.slice(i + 1) };
      }
      if (!escaped && input[i] === '\\') escaped = true;
      else escaped = false;
    }
    return { token: decodeGitQuoted(input), rest: '' };
  }
  const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { token: match?.[1] ?? '', rest: match?.[2] ?? '' };
}

function stripDiffPrefix(value, prefix) {
  const normalized = normalizeRepoPath(value);
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function parseHeaderPath(line, marker) {
  const raw = line.slice(marker.length).replace(/^\s+/, '');
  const token = readGitToken(raw).token;
  if (!token || token === '/dev/null') return null;
  return stripDiffPrefix(token, marker === '+++ ' ? 'b/' : 'a/');
}

/** Parse a Git-style unified diff into per-file paths and added lines. */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let inHunk = false;

  const flush = () => {
    if (!current) return;
    current.path = current.newPath ?? current.oldPath;
    current.deleted = current.newPath === null;
    current.binary = current.binary || false;
    files.push(current);
    current = null;
    inHunk = false;
  };

  for (const line of String(diffText ?? '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      const first = readGitToken(line.slice('diff --git '.length));
      const second = readGitToken(first.rest);
      current = {
        oldPath: first.token ? stripDiffPrefix(first.token, 'a/') : null,
        newPath: second.token ? stripDiffPrefix(second.token, 'b/') : null,
        addedLines: [],
        binary: false,
      };
      continue;
    }
    if (!current && line.startsWith('--- ')) {
      current = { oldPath: null, newPath: null, addedLines: [], binary: false };
    }
    if (!current) continue;

    if (line.startsWith('rename from ')) {
      current.oldPath = normalizeRepoPath(decodeGitQuoted(line.slice('rename from '.length)));
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = normalizeRepoPath(decodeGitQuoted(line.slice('rename to '.length)));
      continue;
    }
    if (line.startsWith('--- ')) {
      current.oldPath = parseHeaderPath(line, '--- ');
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPath = parseHeaderPath(line, '+++ ');
      inHunk = false;
      continue;
    }
    if (/^(?:Binary files .* differ|GIT binary patch)$/.test(line)) {
      current.binary = true;
      inHunk = false;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      current.addedLines.push({ line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (line.startsWith(' ')) {
      newLine += 1;
    } else if (line.startsWith('-')) {
      // Removed lines never participate in content scanning.
    } else if (line.startsWith('\\')) {
      // The "no newline" marker is diff metadata.
    } else {
      inHunk = false;
    }
  }
  flush();
  return files;
}

function isScaffoldException(path) {
  const base = normalizeRepoPath(path).split('/').at(-1);
  return base === '.gitkeep' || base === 'README.md';
}

function isPrivatePath(path) {
  const normalized = normalizeRepoPath(path);
  if (!normalized || isScaffoldException(normalized)) return false;
  return USER_PATHS.some((entry) => entry.endsWith('/')
    ? normalized.startsWith(entry)
    : normalized === entry);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function softValueMatches(line, value) {
  const text = String(value ?? '').trim();
  if (text.length < 3) return false;
  const flags = text.length <= 4 ? 'u' : 'iu';
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(text)}(?![\\p{L}\\p{N}_])`, flags);
  return pattern.test(line);
}

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function linePhoneDigitRuns(line) {
  return [...line.matchAll(/[+\d][+\d\s().-]*/g)].map((match) => digits(match[0])).filter((value) => value.length >= 7);
}

function hardValueMatches(line, entry) {
  const value = String(entry.value ?? '');
  if (!value) return false;
  if (entry.category === 'email') return line.toLowerCase().includes(value.toLowerCase());
  if (entry.category === 'phone') {
    const number = digits(value);
    if (number.length < 7) return false;
    const needle = number.slice(-9);
    return linePhoneDigitRuns(line).some((run) => run.includes(needle));
  }
  return line.toLowerCase().includes(value.toLowerCase());
}

function softValueInBase(repo, base, value, cache) {
  if (!base || !String(value).trim() || /[\r\n]/.test(value)) return false;
  const cacheKey = `${base}\0${value.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const result = spawnSync('git', [
    'grep', '-F', '-i', '-q', '--', String(value), base, '--', '.', ':(exclude)tests/**',
  ], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('git base-tree lookup failed');
  const found = result.status === 0;
  cache.set(cacheKey, found);
  return found;
}

/** Check parsed diff data. Returns findings and the number of diff file sections. */
export function checkDiff(diffText, options = {}) {
  const files = parseUnifiedDiff(diffText);
  const findings = [];
  const baseLookupCache = new Map();
  const denylist = options.denylist ?? { hard: [], soft: [] };
  const ack = options.ack ?? process.env.ROLEFORGE_PRIVACY_ACK;

  for (const file of files) {
    const targetPath = file.newPath ?? file.oldPath;
    if (file.newPath !== null && targetPath && isPrivatePath(targetPath)) {
      findings.push({ type: 'path', path: targetPath });
    }
    if (options.pathsOnly || file.binary || file.newPath === null || !targetPath) continue;

    for (const added of file.addedLines) {
      for (const entry of denylist.hard ?? []) {
        if (hardValueMatches(added.text, entry)) {
          findings.push({ type: 'hard', path: targetPath, line: added.line, category: entry.category });
        }
      }
      for (const entry of denylist.soft ?? []) {
        if (!SOFT_CATEGORIES.has(entry.category) || !softValueMatches(added.text, String(entry.value ?? ''))) continue;
        if (ack !== undefined) {
          findings.push({ type: 'soft-ack', path: targetPath, line: added.line, category: entry.category, value: entry.value, reason: ack });
        } else if (!softValueInBase(options.repo, options.base, String(entry.value ?? ''), baseLookupCache)) {
          findings.push({ type: 'soft', path: targetPath, line: added.line, category: entry.category, value: entry.value });
        }
      }
    }
  }
  return { files, findings, fileCount: files.length };
}

function mainWorktree(repo) {
  const commonDir = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  return dirname(resolve(repo, commonDir));
}

/** Resolve the denylist in the mandated override order. */
export function resolveDenylistPath({ repo = process.cwd(), denylist } = {}) {
  if (denylist) return resolve(repo, denylist);
  if (process.env.ROLEFORGE_PRIVACY_DENYLIST) return resolve(repo, process.env.ROLEFORGE_PRIVACY_DENYLIST);
  return join(mainWorktree(repo), 'local', 'privacy-denylist.json');
}

/** Read and validate a denylist, refusing stale sources when they are present. */
export function loadDenylist(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('denylist missing, unreadable, or invalid');
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.hard) || !Array.isArray(parsed.soft) || !Array.isArray(parsed.sources)) {
    throw new Error('denylist has an invalid format');
  }
  if (typeof parsed.built_at !== 'string' || Number.isNaN(Date.parse(parsed.built_at))) {
    throw new Error('denylist has an invalid build time');
  }
  if (parsed.hard.length + parsed.soft.length === 0) throw new Error('denylist has no entries');
  for (const entry of parsed.hard) {
    if (!HARD_CATEGORIES.has(entry?.category) || typeof entry.value !== 'string' || !entry.value.trim()) {
      throw new Error('denylist has an invalid hard entry');
    }
  }
  for (const entry of parsed.soft) {
    if (!SOFT_CATEGORIES.has(entry?.category) || typeof entry.value !== 'string' || !entry.value.trim()) {
      throw new Error('denylist has an invalid soft entry');
    }
  }

  const sourceRoot = dirname(dirname(resolve(filePath)));
  for (const source of parsed.sources) {
    if (!source || typeof source.path !== 'string' || !(source.sha256 === null || /^[a-f0-9]{64}$/.test(source.sha256))) {
      throw new Error('denylist has an invalid source entry');
    }
    const sourcePath = isAbsolute(source.path) ? source.path : resolve(sourceRoot, source.path);
    if (!existsSync(sourcePath)) continue;
    let currentHash;
    try {
      currentHash = sha256(readFileSync(sourcePath));
    } catch {
      throw new Error('denylist source cannot be checked');
    }
    if (typeof source.sha256 !== 'string' || source.sha256 !== currentHash) {
      throw new Error('denylist is stale');
    }
  }
  return parsed;
}

function addEntry(entries, category, value) {
  const clean = String(value ?? '').trim();
  if (!clean) return;
  const key = `${category}\0${clean.toLocaleLowerCase()}`;
  if (!entries.has(key)) entries.set(key, { category, value: clean });
}

function collectProfileValues(profile, hard, soft) {
  const walk = (value, key = '') => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) walk(childValue, childKey);
      return;
    }
    if (typeof value !== 'string') return;
    if (EMAIL_KEY_RE.test(key)) addEntry(hard, 'email', value);
    if (PHONE_KEY_RE.test(key)) addEntry(hard, 'phone', value);
    if (PRIVATE_KEY_RE.test(key) && value.trim().length >= 4) {
      const category = /birth|dob/i.test(key) ? 'date_of_birth'
        : /address|street|postal|zip/i.test(key) ? 'address'
          : 'id_number';
      addEntry(hard, category, value);
    }
  };
  walk(profile);
  // Only the candidate's own name: other `name` keys (role archetypes, proof points) are not personal names.
  const fullName = profile?.candidate?.full_name;
  if (typeof fullName === 'string' && fullName.trim().length >= 3) addEntry(soft, 'name', fullName);
}

function repoRelative(root, filePath) {
  const path = relative(root, filePath);
  if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error('denylist source is outside the selected root');
  }
  return path.split(sep).join('/');
}

/** Build and write a local-only denylist from a selected main checkout root. */
export async function buildDenylist({ root = mainWorktree(process.cwd()), out = join(root, 'local', 'privacy-denylist.json') } = {}) {
  const absoluteRoot = resolve(root);
  const absoluteOut = resolve(out);
  const hard = new Map();
  const soft = new Map();
  const sources = [];
  const sourcePaths = new Set();
  const addSourcePath = (filePath) => {
    const absolutePath = resolve(filePath);
    if (sourcePaths.has(absolutePath)) return;
    sourcePaths.add(absolutePath);
    const relativePath = repoRelative(absoluteRoot, absolutePath);
    if (!existsSync(absolutePath)) {
      sources.push({ path: relativePath, sha256: null });
      return;
    }
    const bytes = readFileSync(absolutePath);
    sources.push({ path: relativePath, sha256: sha256(bytes) });
    return bytes;
  };

  const profilePath = join(absoluteRoot, 'config', 'profile.yml');
  const profileBytes = addSourcePath(profilePath);
  if (profileBytes) {
    try {
      const yamlModule = await import('js-yaml');
      const profile = yamlModule.default.load(profileBytes.toString('utf8'));
      collectProfileValues(profile, hard, soft);
    } catch {
      throw new Error('profile source cannot be parsed');
    }
  }

  const trackerUtils = await import('../tracker-utils.mjs');
  const trackerParser = await import('../tracker-parse.mjs');
  const trackerPath = trackerUtils.resolveTrackerPath(absoluteRoot);
  const trackerBytes = addSourcePath(trackerPath);
  if (trackerBytes) {
    const lines = trackerBytes.toString('utf8').split(/\r?\n/);
    const columns = trackerParser.resolveColumns(lines);
    for (const line of lines) {
      const row = trackerParser.parseTrackerRow(line, columns);
      if (row && ACCEPTED_STATUSES.has(String(row.status).replace(/\*\*/g, '').trim().toLocaleLowerCase())) {
        addEntry(soft, 'company', row.company);
      }
    }
  }

  const interviewDir = join(absoluteRoot, 'interview-prep');
  let interviewFiles = [];
  if (existsSync(interviewDir)) {
    interviewFiles = readdirSync(interviewDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md'))
      .map((entry) => join(interviewDir, entry.name))
      .sort((a, b) => a.localeCompare(b));
  }
  if (interviewFiles.length === 0) sources.push({ path: 'interview-prep/*.md', sha256: null });
  for (const filePath of interviewFiles) {
    const bytes = addSourcePath(filePath);
    if (!bytes) continue;
    const document = bytes.toString('utf8');
    // Heuristic: collect 2–3 capitalized words following common interviewer/contact labels.
    const name = /^(\p{Lu}[\p{L}\p{M}'’.-]*(?:[ \t]+\p{Lu}[\p{L}\p{M}'’.-]*){1,2})(?=$|[ \t(,:])/u;
    for (const line of document.split(/\r?\n/)) {
      const label = line.match(/^\s*(?:interviewer|recruiter|hiring manager|contact)\s*[:\-]\s*(.*)$/i);
      const person = label?.[1]?.match(name)?.[1];
      if (person) addEntry(soft, 'person', person);
    }
  }

  const denylist = {
    version: 1,
    built_at: new Date().toISOString(),
    sources,
    hard: [...hard.values()],
    soft: [...soft.values()],
  };
  mkdirSync(dirname(absoluteOut), { recursive: true });
  writeFileSync(absoluteOut, `${JSON.stringify(denylist, null, 2)}\n`, { mode: 0o600 });
  return denylist;
}

function parseArgs(argv) {
  const options = { positional: [] };
  const valued = new Set(['--range', '--patch', '--pre-push', '--repo', '--denylist', '--root', '--out']);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--staged' || arg === '--build-denylist' || arg === '--paths-only') {
      if (options[arg.slice(2)]) throw new Error('duplicate option');
      options[arg.slice(2)] = true;
    } else if (valued.has(arg)) {
      if (options[arg.slice(2)] !== undefined || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('missing or duplicate option value');
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('-')) {
      throw new Error('unknown option');
    } else {
      options.positional.push(arg);
    }
  }
  const modes = ['range', 'patch', 'staged', 'pre-push', 'build-denylist'].filter((key) => options[key]);
  if (modes.length !== 1 || options.positional.length || (options['paths-only'] && !options.range)) throw new Error('invalid mode');
  const mode = modes[0];
  if (mode !== 'build-denylist' && (options.root || options.out)) throw new Error('--root and --out are only valid with --build-denylist');
  if (mode === 'build-denylist' && (options.repo || options.denylist || options['paths-only'])) throw new Error('invalid build-denylist options');
  if (options['paths-only'] && options.denylist) throw new Error('paths-only does not accept a denylist');
  if (mode === 'range') {
    const rangeParts = String(options.range).split('..');
    if (rangeParts.length !== 2 || !rangeParts[0] || !rangeParts[1]) throw new Error('range must be <base>..<head>');
  }
  return { ...options, mode };
}

function parseRange(value) {
  const match = String(value).match(/^(.+)\.\.([^.].*)$/);
  if (!match) throw new Error('range must be <base>..<head>');
  return { base: match[1], head: match[2] };
}

function emptyTree(repo) {
  return git(repo, ['hash-object', '-t', 'tree', '--stdin'], '').stdout.trim();
}

function commitParents(repo, commit) {
  const line = git(repo, ['rev-list', '--parents', '-n', '1', commit]).stdout.trim().split(/\s+/);
  if (!line[0]) throw new Error('commit could not be resolved');
  return line.slice(1);
}

function commitDiff(repo, commit) {
  const parents = commitParents(repo, commit);
  const parent = parents[0] ?? emptyTree(repo);
  const diff = git(repo, ['diff', '--no-ext-diff', '--no-color', '--binary', '--find-renames', '--unified=0', parent, commit, '--']).stdout;
  return { diff, base: parent };
}

function listRangeCommits(repo, base, head) {
  return git(repo, ['rev-list', `${base}..${head}`]).stdout.split(/\r?\n/).filter(Boolean);
}

function emitFindings(findings) {
  for (const finding of findings) {
    if (finding.type === 'path') console.error(`private path: ${finding.path}`);
    else if (finding.type === 'hard') console.error(`${finding.path}:${finding.line} ${finding.category}`);
    else if (finding.type === 'soft') console.error(`${finding.path}:${finding.line} ${finding.category} ${finding.value}`);
    else if (finding.type === 'soft-ack') {
      console.error(`${finding.path}:${finding.line} ${finding.category} ${finding.value} (acknowledged: ${finding.reason})`);
    }
  }
}

function requireDenylist(repo, override) {
  const path = resolveDenylistPath({ repo, denylist: override });
  try {
    return loadDenylist(path);
  } catch {
    throw new Error(`content scan not performed; run: ${FIX_COMMAND}`);
  }
}

function checkOne(diff, { repo, base, denylist, pathsOnly = false }) {
  const checked = checkDiff(diff, { repo, base, denylist, pathsOnly });
  if (String(diff).trim() && checked.fileCount === 0) throw new Error('diff could not be parsed');
  return checked;
}

async function runCli(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch {
    console.error('usage error');
    return 2;
  }
  if (options.mode === 'build-denylist') {
    try {
      const root = resolve(options.root ?? mainWorktree(process.cwd()));
      const out = resolve(options.out ?? join(root, 'local', 'privacy-denylist.json'));
      const denylist = await buildDenylist({ root, out });
      console.log(`privacy-guard: denylist built (${denylist.hard.length} hard, ${denylist.soft.length} soft entries)`);
      return 0;
    } catch {
      console.error('privacy-guard: denylist build failed');
      return 1;
    }
  }

  const repo = resolve(options.repo ?? process.cwd());
  let denylist = null;
  if (!options['paths-only']) {
    try {
      denylist = requireDenylist(repo, options.denylist);
    } catch (error) {
      console.error(error.message);
      return 1;
    }
  }

  const allFindings = [];
  let count = 0;
  try {
    if (options.mode === 'range') {
      const { base, head } = parseRange(options.range);
      for (const commit of listRangeCommits(repo, base, head)) {
        const committed = commitDiff(repo, commit);
        const checked = checkOne(committed.diff, { repo, base: committed.base, denylist, pathsOnly: options['paths-only'] });
        allFindings.push(...checked.findings);
        count += 1;
      }
    } else if (options.mode === 'pre-push') {
      const stdin = readFileSync(0, 'utf8');
      const lines = stdin.split(/\r?\n/).filter((line) => line.trim());
      for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || !/^[0-9a-f]+$/i.test(fields[1]) || !/^[0-9a-f]+$/i.test(fields[3])) throw new Error('malformed pre-push input');
        const [localRef, localSha, remoteRef, remoteSha] = fields;
        void localRef;
        void remoteRef;
        if (/^0+$/.test(localSha)) continue;
        let commits;
        if (/^0+$/.test(remoteSha)) {
          commits = git(repo, ['rev-list', localSha, `--not`, `--remotes=${options['pre-push']}`]).stdout.split(/\r?\n/).filter(Boolean);
        } else {
          commits = listRangeCommits(repo, remoteSha, localSha);
        }
        for (const commit of commits) {
          const committed = commitDiff(repo, commit);
          const checked = checkOne(committed.diff, { repo, base: committed.base, denylist });
          allFindings.push(...checked.findings);
          count += 1;
        }
      }
    } else {
      const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
      let diff;
      if (options.mode === 'patch') diff = readFileSync(resolve(options.patch), 'utf8');
      else diff = git(repo, ['diff', '--cached', '--no-ext-diff', '--no-color', '--binary', '--find-renames', '--unified=0', 'HEAD', '--']).stdout;
      const checked = checkOne(diff, { repo, base, denylist });
      allFindings.push(...checked.findings);
      count = checked.fileCount;
    }
  } catch {
    console.error(options['paths-only'] ? 'privacy-guard: path scan failed' : 'privacy-guard: content scan not performed; run: ' + FIX_COMMAND);
    return 1;
  }

  for (const finding of allFindings) {
    if (finding.type === 'soft-ack') console.error(`privacy-guard: acknowledged soft match; reason: ${finding.reason}`);
  }
  const blockingFindings = allFindings.filter((finding) => finding.type !== 'soft-ack');
  if (blockingFindings.length) {
    emitFindings(blockingFindings);
    if (options['paths-only']) console.log('paths-only: no content scan performed');
    return 1;
  }
  if (options['paths-only']) {
    console.log('paths-only: no content scan performed');
    return 0;
  }
  console.log(`privacy-guard: OK (${count} commits/files, content scan performed)`);
  return 0;
}

const invokedAsCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsCli) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
