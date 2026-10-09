#!/usr/bin/env node

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

function canonicalPathWithExistingAncestor(path) {
  let current = resolve(path);
  const remaining = [];

  while (true) {
    try {
      lstatSync(current);
      return resolve(realpathSync.native(current), ...remaining);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      remaining.unshift(basename(current));
      current = parent;
    }
  }
}

function comparable(path) {
  let value = resolve(path).replace(/\\/g, '/');
  if (process.platform === 'win32') value = value.toLowerCase();
  return value.replace(/\/+$/, '') || '/';
}

function isWithin(directory, path) {
  const parent = comparable(directory);
  const candidate = comparable(path);
  return candidate === parent || candidate.startsWith(`${parent === '/' ? '' : parent}/`);
}

function existsIncludingDanglingSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Validate a generated output path before writing it.
 *
 * @param {string} path Requested output path.
 * @param {{root?: string}} [options] Project root containing output/cv-approved/.
 * @returns {string} The resolved output path.
 */
export function assertWritableOutput(path, { root = process.cwd() } = {}) {
  const absolute = resolve(path);
  const approved = resolve(root, 'output', 'cv-approved');
  const physicalAbsolute = canonicalPathWithExistingAncestor(absolute);
  const physicalApproved = canonicalPathWithExistingAncestor(approved);

  if (
    isWithin(approved, absolute)
    || isWithin(approved, physicalAbsolute)
    || isWithin(physicalApproved, absolute)
    || isWithin(physicalApproved, physicalAbsolute)
  ) {
    throw new Error(`Refusing to write into the approved CV directory: ${absolute}`);
  }

  if (existsIncludingDanglingSymlink(absolute)) {
    throw new Error(`Refusing to overwrite existing output: ${absolute}. Choose a different name.`);
  }

  return absolute;
}
