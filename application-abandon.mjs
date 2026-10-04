#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonApplicationBatch } from './application-batch.mjs';
import { isCandidateId } from './candidate-identity.mjs';

export function parseAbandonArgs(argv) {
  const options = { entireBatch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--batch') {
      if (options.entireBatch) throw new Error('Duplicate option: --batch');
      options.entireBatch = true;
      continue;
    }
    if (!['--manifest', '--candidate-id', '--reason'].includes(arg)) throw new Error(`Unknown or forbidden option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    const key = arg.slice(2).replace('-id', 'Id');
    if (options[key]) throw new Error(`Duplicate option: ${arg}`);
    options[key] = value;
  }
  if (!options.manifest) throw new Error('Explicit --manifest path is required');
  if (!options.reason) throw new Error('Explicit human-provided --reason is required');
  if (Boolean(options.candidateId) === Boolean(options.entireBatch)) {
    throw new Error('Use exactly one of --candidate-id <exact-id> or --batch');
  }
  if (options.candidateId && !isCandidateId(options.candidateId)) throw new Error('Exact --candidate-id must be a supported versioned candidate ID');
  return options;
}

export function runAbandonCommand(argv, overrides = {}) {
  const options = parseAbandonArgs(argv);
  return abandonApplicationBatch(options.manifest, {
    ...overrides,
    candidateId: options.candidateId || null,
    entireBatch: options.entireBatch,
    reason: options.reason,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runAbandonCommand(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}
