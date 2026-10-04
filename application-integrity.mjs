import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

function sha256Buffer(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256Canonical(value) {
  return sha256Buffer(Buffer.from(canonicalJson(value), 'utf8'));
}

export function hashFile(path) {
  if (!existsSync(path)) throw new Error(`Required integrity file is missing: ${path}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Required integrity path is not a regular file: ${path}`);
  return { sha256: sha256Buffer(readFileSync(path)), size: stat.size };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

export function readSourceRunIntegrity(root, runId) {
  const runDir = join(resolve(root), 'output', 'scan-runs', runId);
  const manifestPath = join(runDir, 'manifest.json');
  const candidatesPath = join(runDir, 'candidates.json');
  if (!existsSync(manifestPath) || !existsSync(candidatesPath)) {
    throw new Error(`Source run does not exist or lacks manifest.json/candidates.json: ${runId}`);
  }
  const runManifest = readJson(manifestPath, 'source run manifest');
  const manifestRunId = String(runManifest?.run_id ?? runManifest?.runId ?? '').trim();
  if (manifestRunId !== runId) {
    throw new Error(`Source run manifest identity mismatch: expected ${runId}, found ${manifestRunId || '(missing)'}`);
  }
  const candidates = readJson(candidatesPath, 'source candidates');
  if (!Array.isArray(candidates)) throw new Error(`Source candidates must be an array: ${candidatesPath}`);
  const manifestHash = hashFile(manifestPath);
  const candidatesHash = hashFile(candidatesPath);
  return {
    runId,
    manifestPath,
    candidatesPath,
    runManifest,
    candidates,
    integrity: {
      algorithm: 'sha256',
      manifest: { filename: 'manifest.json', ...manifestHash },
      candidates: { filename: 'candidates.json', ...candidatesHash },
    },
  };
}

export function assertSourceRunIntegrity(root, runId, expected = null) {
  const current = readSourceRunIntegrity(root, runId);
  if (expected) {
    for (const key of ['manifest', 'candidates']) {
      if (expected?.[key]?.sha256 !== current.integrity[key].sha256
          || expected?.[key]?.size !== current.integrity[key].size) {
        throw new Error(`Source ${key}.json integrity mismatch for run ${runId}`);
      }
    }
  }
  return current;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function validateReadableFilename(filename) {
  if (!filename || filename.includes('_') || /%20/i.test(filename)) {
    throw new Error('Artifact filenames must be readable and use spaces, never underscores or %20');
  }
  if (filename !== basename(filename)) throw new Error('Artifact intended filename must be a basename');
  return filename;
}

export function createArtifactRecord({
  root,
  artifactType,
  filePath,
  sourceCvVariant = null,
  createdAt = null,
  sourceArtifacts = null,
}) {
  if (!['cv', 'cover_letter', 'cover_letter_text', 'combined_document'].includes(artifactType)) {
    throw new Error(`Unsupported artifact type: ${artifactType}`);
  }
  const supplied = String(filePath ?? '').trim();
  if (!supplied) throw new Error('Explicit artifact file path is required');
  if (supplied.includes('\0') || /%20/i.test(supplied)) throw new Error('Unsafe artifact path');
  const outputRoot = resolve(root, 'output');
  const lexical = resolve(root, supplied);
  if (!isWithin(outputRoot, lexical)) throw new Error('Artifact path must stay inside the approved output directory');
  if (!existsSync(lexical)) throw new Error(`Artifact file is missing: ${supplied}`);
  if (!lstatSync(lexical).isFile() && !lstatSync(lexical).isSymbolicLink()) {
    throw new Error('Artifact path must resolve to a regular file');
  }
  const realOutput = realpathSync(outputRoot);
  const real = realpathSync(lexical);
  if (!isWithin(realOutput, real)) throw new Error('Artifact symlink escapes the approved output directory');
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error('Artifact path must resolve to a regular file');
  const intendedFilename = validateReadableFilename(basename(real));
  const timestamp = createdAt || (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtime.toISOString()
    : null);
  const record = {
    artifactType,
    intendedFilename,
    resolvedPath: real,
    sha256: sha256Buffer(readFileSync(real)),
    size: stat.size,
    sourceCvVariant: artifactType === 'cv' ? (sourceCvVariant || null) : null,
    createdAt: timestamp,
  };
  if (artifactType === 'combined_document') {
    if (!Array.isArray(sourceArtifacts) || sourceArtifacts.length !== 2) throw new Error('Combined document requires exactly two ordered source artifacts');
    record.sourceArtifacts = sourceArtifacts.map((item) => ({ artifactType: item.artifactType, sha256: item.sha256, size: item.size }));
  }
  return record;
}

export function validateArtifactRecord(record, { root, expectedType = null } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Artifact record must be an object');
  const allowed = new Set([
    'artifactType', 'intendedFilename', 'resolvedPath', 'sha256', 'size', 'sourceCvVariant', 'createdAt', 'sourceArtifacts',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`Unknown critical artifact field: ${key}`);
  }
  if (!['cv', 'cover_letter', 'cover_letter_text', 'combined_document'].includes(record.artifactType)) throw new Error('Invalid artifact type');
  if (expectedType && record.artifactType !== expectedType) throw new Error(`Artifact type mismatch: expected ${expectedType}`);
  if (!/^sha256:[a-f0-9]{64}$/.test(record.sha256) || !Number.isInteger(record.size) || record.size < 0) {
    throw new Error('Invalid artifact hash or size record');
  }
  if (record.createdAt != null && !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error('Invalid artifact created timestamp');
  }
  if (record.artifactType === 'combined_document') {
    if (!Array.isArray(record.sourceArtifacts) || record.sourceArtifacts.length !== 2) throw new Error('Combined document source binding is incomplete');
    for (const source of record.sourceArtifacts) {
      if (!['cv', 'cover_letter'].includes(source.artifactType) || !/^sha256:[a-f0-9]{64}$/.test(source.sha256) || !Number.isInteger(source.size)) {
        throw new Error('Combined document source binding is invalid');
      }
    }
  } else if (record.sourceArtifacts != null) throw new Error('Only combined documents may contain source artifact bindings');
  validateReadableFilename(record.intendedFilename);
  if (!isAbsolute(record.resolvedPath)) throw new Error('Artifact resolved path must be absolute');
  const outputRoot = realpathSync(resolve(root, 'output'));
  if (!existsSync(record.resolvedPath)) throw new Error(`Bound artifact is missing: ${record.intendedFilename}`);
  const real = realpathSync(record.resolvedPath);
  if (!isWithin(outputRoot, real)) throw new Error('Bound artifact resolves outside the approved output directory');
  if (real !== record.resolvedPath) throw new Error('Bound artifact resolved path changed');
  if (basename(real) !== record.intendedFilename) throw new Error('Artifact filename does not match its bound path');
  const current = hashFile(real);
  if (current.sha256 !== record.sha256 || current.size !== record.size) {
    throw new Error(`Artifact hash or size mismatch: ${record.intendedFilename}`);
  }
  return record;
}
