#!/usr/bin/env node

import {
  copyFileSync, createReadStream, lstatSync, mkdirSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, toNamespacedPath } from 'node:path';

const SOURCES = [
  'cv.md', 'config/profile.yml', 'modes/_profile.md', 'modes/_custom.md',
  'article-digest.md', 'portals.yml', 'voice-dna.md', 'writing-samples',
  'data', 'reports', 'interview-prep', 'jds', 'output/cv-approved',
  'output/application-answer-bank.md', 'output/application-batches', 'output/scan-runs',
];
const EXCLUDED = new Set(['backups', 'preimages', 'node_modules']);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function usage() {
  return [
    'Usage: node backup.mjs [--dry-run] [--help]',
    '',
    'Back up user files and authoritative application state from the current directory.',
    'Store relative paths and a SHA-256 manifest in backups/<UTC timestamp>/.',
    'Keep the newest 5 complete backups. Skip missing sources, backups/, preimages/, node_modules/.',
    'Restore manually by copying files from a backup to the same relative paths in the project.',
    '--dry-run prints file count and total bytes without writing anything.',
  ].join('\n');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg !== '--help' && arg !== '--dry-run') throw new Error(`Unknown argument: ${arg}\n${usage()}`);
  }
  if (args.includes('--help')) {
    console.log(usage());
    return;
  }

  const root = process.cwd();
  const diskPath = (path) => toNamespacedPath(resolve(root, path));
  const files = [];
  const directories = [];
  const failures = [];
  const fail = (path, error) => failures.push({ path, error: error.message });
  const reportFailures = () => {
    console.error(`Backup failed (${failures.length} failures):`);
    for (const failure of failures) console.error(`- ${failure.path}: ${failure.error}`);
    process.exitCode = 1;
  };

  function visit(path, optional = false) {
    try {
      const info = lstatSync(diskPath(path));
      if (info.isSymbolicLink()) throw new Error('Symbolic links are not backed up; use a regular file or directory.');
      if (info.isDirectory()) {
        directories.push(path);
        for (const entry of readdirSync(diskPath(path)).sort()) {
          if (!EXCLUDED.has(entry.toLowerCase())) visit(`${path}/${entry}`);
        }
      } else if (info.isFile()) {
        files.push({ path, size: info.size });
      } else {
        throw new Error('Unsupported file type.');
      }
    } catch (error) {
      if (!optional || error.code !== 'ENOENT') fail(path, error);
    }
  }

  for (const source of SOURCES) {
    try {
      // Do not traverse a linked parent of a selected file (e.g. config/).
      const parts = source.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        if (lstatSync(diskPath(parts.slice(0, i).join('/'))).isSymbolicLink()) {
          throw new Error('Source parent is a symbolic link.');
        }
      }
      visit(source, true);
    } catch (error) {
      if (error.code !== 'ENOENT') fail(source, error);
    }
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (args.includes('--dry-run')) {
    console.log(`Dry run: ${files.length} files, ${totalBytes} bytes.`);
  }
  if (failures.length) {
    reportFailures();
    return;
  }
  if (args.includes('--dry-run')) return;

  const backupRoot = diskPath('backups');
  try {
    const info = lstatSync(backupRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('backups/ must be a regular directory.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    mkdirSync(backupRoot);
  }

  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, '-');
  const destination = `backups/${timestamp}`;
  const staging = `${destination}.incomplete`;
  // Exclusive creation prevents a same-timestamp run from overwriting a backup.
  try {
    lstatSync(diskPath(destination));
    throw new Error(`Backup already exists: ${destination}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(diskPath(staging));
  for (const directory of directories) {
    try {
      mkdirSync(diskPath(`${staging}/${directory}`), { recursive: true });
    } catch (error) {
      fail(directory, error);
    }
  }

  const copied = [];
  for (const file of files) {
    try {
      const target = diskPath(`${staging}/${file.path}`);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(diskPath(file.path), target);
      copied.push({ path: file.path, size: statSync(target).size, sha256: await sha256(target) });
    } catch (error) {
      fail(file.path, error);
    }
  }
  try {
    writeFileSync(diskPath(`${staging}/manifest.json`), `${JSON.stringify({
      createdAt, complete: failures.length === 0, files: copied, failures,
    }, null, 2)}\n`);
  } catch (error) {
    fail(`${staging}/manifest.json`, error);
  }
  if (failures.length) {
    reportFailures();
    console.error(`Incomplete backup left at ${staging}; older backups retained.`);
    return;
  }
  renameSync(diskPath(staging), diskPath(destination));

  const backups = readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && TIMESTAMP.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
  for (const old of backups.slice(5)) {
    try {
      // Only direct timestamp directories under this project's backups/ are eligible.
      rmSync(diskPath(`backups/${old}`), { recursive: true });
    } catch (error) {
      fail(`backups/${old}`, error);
    }
  }
  console.log(`Backup: ${copied.length} files, ${copied.reduce((sum, file) => sum + file.size, 0)} bytes -> ${destination}/`);
  console.log('Restore manually: copy files from that backup to the same relative paths in the project.');
  if (failures.length) reportFailures();
}

main().catch((error) => {
  console.error(`Backup failed: ${error.message}`);
  process.exitCode = 1;
});
