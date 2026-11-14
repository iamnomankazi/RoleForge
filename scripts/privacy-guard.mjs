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
  const token = raw.startsWith('"')
    ? readGitToken(raw).token
    : raw.split('\t', 1)[0].trimEnd();
  if (!token || token === '/dev/null') return null;
  return stripDiffPrefix(token, marker === '+++ ' ? 'b/' : 'a/');
}

function parseMetadataPath(line, marker) {
  const raw = line.slice(marker.length).trimStart();
  const value = raw.startsWith('"') ? readGitToken(raw).token : raw.trimEnd();
  return value ? normalizeRepoPath(value) : null;
}

function parseDiffGitPaths(line) {
  const raw = line.slice('diff --git '.length);
  if (raw.startsWith('"')) {
    const first = readGitToken(raw);
    const second = readGitToken(first.rest);
    return {
      oldPath: first.token ? stripDiffPrefix(first.token, 'a/') : null,
      newPath: second.token ? stripDiffPrefix(second.token, 'b/') : null,
    };
  }

  // Unquoted paths containing spaces are ambiguous unless both sides are equal.
  // Look for the separator from the end so a path can itself contain " b/".
  const separators = [...raw.matchAll(/ b\//g)];
  for (const separator of separators.reverse()) {
    const index = separator.index;
    const oldRaw = raw.slice(0, index);
    const newRaw = raw.slice(index + 1);
    if (!oldRaw.startsWith('a/') || !newRaw.startsWith('b/')) continue;
    const oldPath = stripDiffPrefix(oldRaw, 'a/');
    const newPath = stripDiffPrefix(newRaw, 'b/');
    if (oldPath === newPath) return { oldPath, newPath };
  }

  const first = readGitToken(raw);
  const second = readGitToken(first.rest);
  return {
    oldPath: first.token ? stripDiffPrefix(first.token, 'a/') : null,
    newPath: second.token ? stripDiffPrefix(second.token, 'b/') : null,
  };
}

/** Parse a Git-style unified diff into per-file paths and added lines. */
export function parseUnifiedDiff(diffText) {
  const files = [];
  let current = null;
  let newLine = 0;
  let inHunk = false;
  let oldRemaining = 0;
  let newRemaining = 0;

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
    if (line.startsWith('diff --git ') && !inHunk) {
      flush();
      const paths = parseDiffGitPaths(line);
      current = {
        oldPath: paths.oldPath,
        newPath: paths.newPath,
        addedLines: [],
        binary: false,
      };
      continue;
    }

    // Hunk counts distinguish content that happens to look exactly like file
    // metadata (for example an added line beginning with "+++").
    if (inHunk) {
      if (line.startsWith('\\')) continue;
      if (line.startsWith('+')) {
        current.addedLines.push({ line: newLine, text: line.slice(1) });
        newLine += 1;
        newRemaining -= 1;
      } else if (line.startsWith('-')) {
        oldRemaining -= 1;
      } else if (line.startsWith(' ')) {
        newLine += 1;
        oldRemaining -= 1;
        newRemaining -= 1;
      } else {
        inHunk = false;
      }
      if (inHunk && oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      if (inHunk || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) continue;
    }

    if (!current && line.startsWith('--- ')) {
      current = { oldPath: null, newPath: null, addedLines: [], binary: false };
    }
    if (!current) continue;

    if (line.startsWith('new file mode ')) {
      current.oldPath = null;
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      current.newPath = null;
      continue;
    }
    if (line.startsWith('rename from ') || line.startsWith('copy from ')) {
      current.oldPath = parseMetadataPath(line, line.startsWith('rename from ') ? 'rename from ' : 'copy from ');
      continue;
    }
    if (line.startsWith('rename to ') || line.startsWith('copy to ')) {
      current.newPath = parseMetadataPath(line, line.startsWith('rename to ') ? 'rename to ' : 'copy to ');
      continue;
    }
    if (line.startsWith('--- ')) {
      current.oldPath = parseHeaderPath(line, '--- ');
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.newPath = parseHeaderPath(line, '+++ ');
      continue;
    }
    if (/^(?:Binary files .* differ|GIT binary patch)$/.test(line)) {
      current.binary = true;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
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
    if (options.pathsOnly || file.newPath === null || !targetPath) continue;
    if (file.binary) {
      if (options.deletedPaths?.has(targetPath)) continue;
      findings.push(ack === undefined
        ? { type: 'binary', path: targetPath }
        : { type: 'binary-ack', path: targetPath, reason: ack });
      continue;
    }

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
    if (source.path === 'interview-prep/*.md') throw new Error('denylist is stale');
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

  const recordedInterviewFiles = new Map(parsed.sources
    .filter((source) => /^interview-prep\/[^/]+\.md$/i.test(normalizeRepoPath(source.path)))
    .map((source) => [normalizeRepoPath(source.path), source.sha256]));
  const interviewDir = join(sourceRoot, 'interview-prep');
  let currentInterviewFiles = [];
  try {
    if (existsSync(interviewDir)) {
      currentInterviewFiles = readdirSync(interviewDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLocaleLowerCase().endsWith('.md'))
        .map((entry) => {
          const path = `interview-prep/${entry.name}`;
          return [path, sha256(readFileSync(join(interviewDir, entry.name)))];
        });
    }
  } catch {
    throw new Error('denylist source cannot be checked');
  }
  if (recordedInterviewFiles.size !== currentInterviewFiles.length
    || currentInterviewFiles.some(([path, hash]) => recordedInterviewFiles.get(path) !== hash)) {
    throw new Error('denylist is stale');
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
    if (rangeParts.length !== 2 || !rangeParts[1]) throw new Error('range must be <base>..<head>');
  }
  return { ...options, mode };
}

function parseRange(value) {
  const range = String(value);
  const separator = range.indexOf('..');
  if (separator < 0 || separator + 2 >= range.length || range.indexOf('..', separator + 2) >= 0) {
    throw new Error('range must be <base>..<head>');
  }
  return { base: range.slice(0, separator), head: range.slice(separator + 2) };
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
  const pathInfo = changedPathInfo(repo, ['diff', '-z', '--name-status', '-C', '-M', parent, commit, '--']);
  return { diff, base: parent, ...pathInfo };
}

function listRangeCommits(repo, base, head) {
  const revision = base ? `${base}..${head}` : head;
  return git(repo, ['rev-list', revision]).stdout.split(/\r?\n/).filter(Boolean);
}

function changedPathInfo(repo, args) {
  const fields = git(repo, args).stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const findings = [];
  const deletedPaths = new Set();
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    let targetPath;
    if (/^[RC]/.test(status)) {
      if (i + 1 >= fields.length) throw new Error('git path status was malformed');
      i += 1; // source path
      targetPath = fields[i++];
    } else {
      if (i >= fields.length) throw new Error('git path status was malformed');
      targetPath = fields[i++];
      if (status.startsWith('D')) {
        deletedPaths.add(targetPath);
        continue;
      }
    }
    if (isPrivatePath(targetPath)) findings.push({ type: 'path', path: targetPath });
  }
  return { pathFindings: findings, deletedPaths };
}

function redactDiagnostic(value, denylist) {
  let output = String(value);
  const hard = denylist?.hard ?? [];
  const literalValues = hard
    .filter((entry) => entry.category !== 'phone')
    .map((entry) => String(entry.value ?? '').trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const secret of literalValues) {
    output = output.replace(new RegExp(escapeRegExp(secret), 'giu'), '[REDACTED]');
  }

  const phoneNeedles = hard
    .filter((entry) => entry.category === 'phone')
    .map((entry) => digits(entry.value))
    .filter(Boolean)
    .map((number) => number.length >= 7 ? number.slice(-9) : number);
  if (phoneNeedles.length) {
    output = output.replace(/[+\d][+\d\s().-]*/g, (candidate) => {
      const run = digits(candidate);
      return phoneNeedles.some((needle) => run.includes(needle)) ? '[REDACTED]' : candidate;
    });
  }
  return output;
}

function emitFindings(findings, denylist) {
  for (const finding of findings) {
    let message;
    if (finding.type === 'path') message = `private path: ${finding.path}`;
    else if (finding.type === 'hard') message = `${finding.path}:${finding.line} ${finding.category}`;
    else if (finding.type === 'soft') message = `${finding.path}:${finding.line} ${finding.category} ${finding.value}`;
    else if (finding.type === 'soft-ack') message = `privacy-guard: acknowledged soft match; reason: ${finding.reason}`;
    else if (finding.type === 'binary') message = `binary file: ${finding.path}`;
    else if (finding.type === 'binary-ack') message = `privacy-guard: acknowledged binary file: ${finding.path}; reason: ${finding.reason}`;
    if (message) console.error(redactDiagnostic(message, denylist));
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

function checkOne(diff, { repo, base, denylist, pathsOnly = false, pathFindings = null, deletedPaths = null }) {
  const checked = checkDiff(diff, { repo, base, denylist, pathsOnly, deletedPaths });
  if (String(diff).trim() && checked.fileCount === 0) throw new Error('diff could not be parsed');
  if (pathFindings) {
    checked.findings = [...checked.findings.filter((finding) => finding.type !== 'path'), ...pathFindings];
  }
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
        const checked = checkOne(committed.diff, {
          repo, base: committed.base, denylist, pathsOnly: options['paths-only'],
          pathFindings: committed.pathFindings, deletedPaths: committed.deletedPaths,
        });
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
          const checked = checkOne(committed.diff, {
            repo, base: committed.base, denylist, pathFindings: committed.pathFindings, deletedPaths: committed.deletedPaths,
          });
          allFindings.push(...checked.findings);
          count += 1;
        }
      }
    } else {
      const base = git(repo, ['rev-parse', 'HEAD']).stdout.trim();
      let diff;
      let pathInfo = null;
      if (options.mode === 'patch') diff = readFileSync(resolve(options.patch), 'utf8');
      else {
        diff = git(repo, ['diff', '--cached', '--no-ext-diff', '--no-color', '--binary', '--find-renames', '--unified=0', 'HEAD', '--']).stdout;
        pathInfo = changedPathInfo(repo, ['diff', '--cached', '-z', '--name-status', '-C', '-M', 'HEAD', '--']);
      }
      const checked = checkOne(diff, { repo, base, denylist, ...(pathInfo ?? {}) });
      allFindings.push(...checked.findings);
      count = checked.fileCount;
    }
  } catch {
    console.error(options['paths-only'] ? 'privacy-guard: path scan failed' : 'privacy-guard: content scan not performed; run: ' + FIX_COMMAND);
    return 1;
  }

  const acknowledgedFindings = allFindings.filter((finding) => finding.type === 'soft-ack' || finding.type === 'binary-ack');
  emitFindings(acknowledgedFindings, denylist);
  const blockingFindings = allFindings.filter((finding) => finding.type !== 'soft-ack' && finding.type !== 'binary-ack');
  if (blockingFindings.length) {
    emitFindings(blockingFindings, denylist);
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
