import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIVENESS_CONTEXT_OPTIONS } from './liveness-browser.mjs';

const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
export const BROWSER_PROFILE_ROOT_ENV = 'ROLEFORGE_BROWSER_PROFILE_ROOT';

export function browserProfilePaths({ root = PROJECT_ROOT, profileRoot } = {}) {
  const basePath = resolve(
    profileRoot || process.env[BROWSER_PROFILE_ROOT_ENV] || join(root, 'local', 'browser-profiles'),
  );
  return {
    profileRoot: basePath,
    profileDir: join(basePath, 'roleforge-ats'),
    lockPath: join(basePath, '.roleforge-ats.lock'),
  };
}

function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8');
    return { raw, owner: JSON.parse(raw) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new Error(`Browser profile lock is unreadable; refusing to remove it: ${lockPath}`);
    }
    throw error;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function validOwner(owner) {
  return Number.isSafeInteger(owner?.pid) && owner.pid > 0
    && typeof owner?.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt))
    && typeof owner?.hostname === 'string' && owner.hostname.length > 0
    && typeof owner?.token === 'string' && owner.token.length > 0;
}

function acquireRecoveryMutex(lockPath, contents, owner) {
  const recoveryPath = `${lockPath}.recovery`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor;
    try {
      descriptor = openSync(recoveryPath, 'wx', 0o600);
      writeFileSync(descriptor, contents, 'utf8');
      closeSync(descriptor);
      return () => {
        if (readLock(recoveryPath)?.owner?.token === owner.token) unlinkSync(recoveryPath);
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if (error.code !== 'EEXIST') throw error;
      throw new Error(`Browser profile lock recovery is already running or stale: ${recoveryPath}. Delete this file manually only after confirming no RoleForge browser is running.`);
    }
  }
  throw new Error(`Could not acquire browser profile recovery mutex: ${recoveryPath}`);
}

export function acquireBrowserProfileLock({ root = PROJECT_ROOT, profileRoot } = {}) {
  const paths = browserProfilePaths({ root, profileRoot });
  mkdirSync(paths.profileRoot, { recursive: true });
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
    token: randomUUID(),
  };
  const contents = `${JSON.stringify(owner)}\n`;
  // Every contender holds this exclusive mutex through ownership rereads,
  // stale removal and reacquisition, including a normal first acquisition.
  const releaseRecovery = acquireRecoveryMutex(paths.lockPath, contents, owner);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor;
      try {
        descriptor = openSync(paths.lockPath, 'wx', 0o600);
        writeFileSync(descriptor, contents, 'utf8');
        closeSync(descriptor);
        descriptor = undefined;
        return {
          ...paths,
          owner,
          release() {
            const current = readLock(paths.lockPath);
            if (!current || current.owner?.token !== owner.token) return false;
            unlinkSync(paths.lockPath);
            return true;
          },
        };
      } catch (error) {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          try { unlinkSync(paths.lockPath); } catch (cleanupError) {
            if (cleanupError.code !== 'ENOENT') throw cleanupError;
          }
        }
        if (error.code !== 'EEXIST') throw error;

        const existing = readLock(paths.lockPath);
        if (!existing) continue;
        if (!validOwner(existing.owner)) {
          throw new Error(`Browser profile lock has invalid ownership data; refusing to recover it: ${paths.lockPath}`);
        }
        if (existing.owner.hostname !== hostname()) {
          throw new Error(`Browser profile is locked by pid ${existing.owner.pid} on host ${existing.owner.hostname}; remote owners cannot be confirmed gone`);
        }
        if (processIsAlive(existing.owner.pid)) {
          throw new Error(`Browser profile is already in use by pid ${existing.owner.pid} since ${existing.owner.startedAt}`);
        }

        // Compare before removing so a lock replaced since it was read is never
        // mistaken for the confirmed-dead owner.
        const latest = readLock(paths.lockPath);
        if (!latest) continue;
        if (latest.raw !== existing.raw) continue;
        try {
          unlinkSync(paths.lockPath);
        } catch (removeError) {
          if (removeError.code !== 'ENOENT') throw removeError;
        }
      }
    }
    throw new Error(`Could not acquire browser profile lock after stale-lock recovery: ${paths.lockPath}`);
  } finally {
    releaseRecovery();
  }
}

export async function openPersistentBrowserProfile({
  root = PROJECT_ROOT,
  profileRoot,
  headless = false,
  contextOptions = LIVENESS_CONTEXT_OPTIONS,
  chromium: chromiumOverride,
  closeStartupPages = true,
} = {}) {
  const lock = acquireBrowserProfileLock({ root, profileRoot });
  let context;
  let closed = false;
  try {
    const chromium = chromiumOverride || (await import('playwright')).chromium;
    context = await chromium.launchPersistentContext(lock.profileDir, {
      ...contextOptions,
      headless,
    });
    context.on('close', () => lock.release());
    if (closeStartupPages) {
      for (const page of context.pages()) await page.close().catch(() => {});
    }
    return {
      context,
      browser: context.browser(),
      profileDir: lock.profileDir,
      lockPath: lock.lockPath,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await context.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (error) {
    if (context) await context.close().catch(() => {});
    lock.release();
    throw error;
  }
}
