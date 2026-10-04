import { mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function owner(lockDir) {
  try { return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

function recoverable(lockDir, staleMs) {
  const current = owner(lockDir);
  if (current?.pid) return !alive(current.pid);
  try { return Date.now() - statSync(lockDir).mtimeMs > Math.max(staleMs, 1000); } catch { return true; }
}

export async function acquirePortalHealthLock(filePath, options = {}) {
  const lockDir = `${filePath}.lock`;
  const recovery = `${lockDir}.recover`;
  const timeoutMs = options.timeoutMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_TIMEOUT_MS) || 8000);
  const retryMs = options.retryMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_RETRY_MS) || 80);
  const staleMs = options.staleMs ?? (Number(process.env.CAREER_OPS_PORTAL_HEALTH_LOCK_STALE_MS) || 30_000);
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  mkdirSync(dirname(lockDir), { recursive: true });

  for (;;) {
    try {
      mkdirSync(lockDir);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let guard = false;
      try { mkdirSync(recovery); guard = true; } catch (guardError) {
        if (guardError?.code !== 'EEXIST') throw guardError;
        if (recoverable(recovery, staleMs)) rmSync(recovery, { recursive: true, force: true });
      }
      if (guard) {
        try {
          if (recoverable(lockDir, staleMs)) {
            rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } finally {
          rmSync(recovery, { recursive: true, force: true });
        }
      }
      if (Date.now() > deadline) throw new Error(`portal-health lock timeout: ${lockDir}`);
      await sleep(retryMs);
      continue;
    }

    try {
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }));
    } catch (error) {
      rmSync(lockDir, { recursive: true, force: true });
      throw error;
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        if (owner(lockDir)?.token === token) rmSync(lockDir, { recursive: true, force: true });
      },
    };
  }
}

export async function withPortalHealthLock(filePath, callback, options = {}) {
  const lock = await acquirePortalHealthLock(filePath, options);
  try { return await callback(); } finally { lock.release(); }
}
