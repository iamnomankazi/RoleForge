#!/usr/bin/env node

/**
 * Shared-browser application preparation coordinator.
 *
 * Authority remains one immutable, confirmed, single-candidate application
 * batch per tab. This module owns only the headed Chromium/context/page
 * lifecycle; the canonical executor retains every candidate-level check,
 * lock, state transition, form action, and evidence write.
 */

import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  loadBatchState,
  loadExecutionContract,
} from './application-batch.mjs';
import {
  assertExecutorState,
  executeCandidateInBrowserContext,
} from './application-browser-executor.mjs';
import { LIVENESS_CONTEXT_OPTIONS } from './liveness-browser.mjs';
import { openPersistentBrowserProfile } from './browser-profile.mjs';

export const MAX_SHARED_BROWSER_CANDIDATES = 6;

function exactBatchId(value) {
  const batchId = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(batchId)) {
    throw new Error(`Invalid exact application batch ID: ${value || '(missing)'}`);
  }
  return batchId;
}

function pathInside(parent, child) {
  const childRelative = relative(resolve(parent), resolve(child));
  return childRelative === '' || (!childRelative.startsWith('..') && !isAbsolute(childRelative));
}

export function manifestPathForBatch(root, batchId) {
  const exactId = exactBatchId(batchId);
  const batchesRoot = resolve(root, 'output', 'application-batches');
  const manifestPath = resolve(batchesRoot, exactId, 'manifest.json');
  if (!pathInside(batchesRoot, manifestPath)) throw new Error(`Unsafe application batch path: ${batchId}`);
  return manifestPath;
}

export function parseSharedBrowserArgs(argv) {
  const batchIds = [];
  let humanWaitMs;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--human-wait-ms') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0 || humanWaitMs != null) throw new Error('Invalid or duplicate --human-wait-ms');
      humanWaitMs = value;
      continue;
    }
    if (arg !== '--batch-id') throw new Error(`Unknown or forbidden option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --batch-id');
    batchIds.push(exactBatchId(value));
    index += 1;
  }
  if (!batchIds.length) throw new Error('At least one exact --batch-id is required');
  if (batchIds.length > MAX_SHARED_BROWSER_CANDIDATES) {
    throw new Error(`Shared browser preparation supports at most ${MAX_SHARED_BROWSER_CANDIDATES} exact batches`);
  }
  if (new Set(batchIds).size !== batchIds.length) {
    throw new Error('Duplicate application batch IDs are not allowed');
  }
  return { batchIds, ...(humanWaitMs == null ? {} : { humanWaitMs }) };
}

export function buildSharedBrowserPlan(batchIds, {
  root = ROOT,
  loadState = loadBatchState,
  loadContract = loadExecutionContract,
} = {}) {
  const { batchIds: exactBatchIds } = parseSharedBrowserArgs(
    batchIds.flatMap((batchId) => ['--batch-id', batchId]),
  );
  return exactBatchIds.map((batchId, order) => {
    const manifestPath = manifestPathForBatch(root, batchId);
    const loaded = loadState(manifestPath, { root });
    if (loaded.manifest.batchId !== batchId) {
      throw new Error(`Batch directory/manifest identity mismatch: ${batchId} != ${loaded.manifest.batchId}`);
    }
    if (loaded.manifest.expectedCandidateCount !== 1 || loaded.manifest.candidates.length !== 1) {
      throw new Error(`Shared browser preparation requires one-candidate batch ${batchId}`);
    }
    if (loaded.state.candidates.length !== 1) {
      throw new Error(`Shared browser state is not one-candidate scoped: ${batchId}`);
    }
    const candidateId = loaded.manifest.candidates[0].candidate_id;
    const contract = loadContract(manifestPath, candidateId, { root, requireCoverLetter: true });
    const resumePreparation = ['actual_form_reached', 'review_required', 'blocked', 'login_required', 'human_action_required'].includes(
      contract.candidateState.state,
    );
    assertExecutorState({
      resumeLogin: false,
      resumePreparation,
    }, contract);
    if (contract.candidate.candidate_id !== candidateId) {
      throw new Error(`Execution contract candidate mismatch for batch ${batchId}`);
    }
    return {
      order,
      batchId,
      manifestPath,
      candidateId,
      company: contract.candidate.company,
      title: contract.candidate.title,
      listingUrl: contract.candidate.listingUrl,
      applyUrl: contract.candidate.applyUrl || null,
      cv: contract.candidate.artifacts.cv?.intendedFilename || null,
      coverLetter: contract.candidate.artifacts.coverLetter?.intendedFilename || null,
      resumePreparation,
      evidenceRoot: join(dirname(contract.manifestPath), 'evidence', candidateId),
      page: null,
      result: null,
      error: null,
    };
  });
}

function waitForDisconnect(browser) {
  if (!browser.isConnected()) return Promise.resolve();
  return new Promise((resolveDisconnected) => browser.once('disconnected', resolveDisconnected));
}

export async function runSharedBrowserSession({ batchIds, root = ROOT, humanWaitMs }, dependencies = {}) {
  // Every immutable source, artifact hash, manifest scope, confirmation, exact
  // candidate ID, and initial state is verified before Chromium is launched.
  const plan = buildSharedBrowserPlan(batchIds, {
    root,
    loadState: dependencies.loadState,
    loadContract: dependencies.loadContract,
  });
  const ownedSession = dependencies.openBrowserProfile
    ? await dependencies.openBrowserProfile({ root, headless: false, contextOptions: LIVENESS_CONTEXT_OPTIONS })
    : dependencies.launchBrowser
      ? {
        browser: await dependencies.launchBrowser(),
        context: null,
        close: null,
      }
      : await openPersistentBrowserProfile({ root, headless: false, contextOptions: LIVENESS_CONTEXT_OPTIONS });
  const browser = ownedSession.browser;
  let context = ownedSession.context;
  try {
    if (!context) {
      context = dependencies.createContext
        ? await dependencies.createContext(browser)
        : await browser.newContext(LIVENESS_CONTEXT_OPTIONS);
    }
    if (dependencies.configureContext) await dependencies.configureContext(context, plan);
    for (const startupPage of context.pages()) await startupPage.close().catch(() => {});

    const execute = dependencies.executeCandidate || executeCandidateInBrowserContext;
    let activeCandidatePage = null;
    for (const entry of plan) {
      if (activeCandidatePage) {
        for (const previousPage of context.pages()) await previousPage.close().catch(() => {});
        activeCandidatePage = null;
      }
      if (!browser.isConnected()) {
        entry.error = 'Shared browser was closed by the user before this candidate started';
        continue;
      }
      try {
        entry.page = await context.newPage();
        const executorDependencies = dependencies.executorDependencies
          ? await dependencies.executorDependencies(entry)
          : {};
        entry.result = await execute({
          manifest: entry.manifestPath,
          candidateId: entry.candidateId,
          headless: false,
          keepOpen: true,
          resumeLogin: false,
          resumePreparation: entry.resumePreparation,
          prepareForm: true,
          ...(humanWaitMs == null ? {} : { humanWaitMs }),
        }, {
          root,
          browser,
          context,
          page: entry.page,
          dependencies: {
            ...executorDependencies,
            onCandidatePage: async (currentPage, contract) => {
              entry.page = currentPage;
              if (executorDependencies.onCandidatePage) {
                await executorDependencies.onCandidatePage(currentPage, contract);
              }
            },
          },
        });
      } catch (error) {
        // Candidate executor locks release in its own finally block. A local
        // candidate failure cannot close this coordinator-owned browser/context.
        entry.error = String(error?.message || error);
      }
      if (entry.error) {
        for (const activePage of context.pages()) {
          if (!activePage.isClosed?.()) await activePage.close().catch(() => {});
        }
        entry.page = null;
      } else {
        activeCandidatePage = entry.page;
      }
      if (dependencies.onCandidateComplete) await dependencies.onCandidateComplete(entry);
    }

    const handoffTimedOut = plan.at(-1)?.result?.state === 'human_action_required';
    if (handoffTimedOut) {
      if (ownedSession.close) await ownedSession.close();
      else if (browser.isConnected()) await browser.close();
    }
    const summary = {
      browserMode: 'one_shared_headed_context',
      candidateCount: plan.length,
      completed: plan.map((entry) => ({
        order: entry.order + 1,
        batchId: entry.batchId,
        candidateId: entry.candidateId,
        company: entry.company,
        title: entry.title,
        state: entry.result?.state || null,
        error: entry.error,
        evidenceRoot: entry.evidenceRoot,
        submissionAvailable: false,
        trackerUpdated: false,
      })),
      browserRemainsOpen: browser.isConnected(),
      submissionAvailable: false,
      trackerUpdated: false,
    };
    if (dependencies.onSessionPrepared) await dependencies.onSessionPrepared(summary, plan);
    if (!handoffTimedOut) {
      await (dependencies.waitForBrowserClose || waitForDisconnect)(browser);
    }
    return {
      ...summary,
      browserRemainsOpen: browser.isConnected(),
    };
  } finally {
    if (ownedSession.close) await ownedSession.close().catch(() => {});
  }
}

function usage() {
  return 'Usage: node application-shared-browser.mjs --batch-id <exact-single-candidate-batch> [--batch-id <next-batch> ...] [--human-wait-ms <milliseconds>]';
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const options = parseSharedBrowserArgs(process.argv.slice(2));
  const result = await runSharedBrowserSession(options, {
    onCandidateComplete(entry) {
      const status = entry.error ? `error: ${entry.error}` : `state: ${entry.result?.state || 'unknown'}`;
      console.log(`[${entry.order + 1}/${options.batchIds.length}] ${entry.company} — ${entry.title}: ${status}`);
    },
    onSessionPrepared(summary) {
      console.log(JSON.stringify(summary, null, 2));
      console.log(summary.browserRemainsOpen
        ? 'Candidate pages close before the next candidate starts. Close the shared task browser to finish.'
        : 'The task browser is closed. Persisted human handoffs can resume using the exact manifest and candidate command shown above.');
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
