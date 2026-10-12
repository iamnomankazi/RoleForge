import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  acquireBrowserProfileLock,
  browserProfilePaths,
  openPersistentBrowserProfile,
} from '../browser-profile.mjs';

function temporaryProfileRoot() {
  return join(mkdtempSync(join(tmpdir(), 'roleforge-browser-profile-')), 'profiles');
}

test('persistent profile retains a local HTTP cookie across close and relaunch', async () => {
  const profileRoot = temporaryProfileRoot();
  const server = createServer((request, response) => {
    if (request.url === '/set') {
      response.writeHead(200, {
        'Set-Cookie': 'roleforge_fixture_cookie=persisted-value; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax',
        'Content-Type': 'text/plain',
      });
      response.end('cookie set');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end(request.headers.cookie || 'no cookie');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  let first;
  let second;
  try {
    first = await openPersistentBrowserProfile({ profileRoot, headless: true });
    const initialPage = await first.context.newPage();
    assert.deepEqual(first.context.pages(), [initialPage], 'Chromium startup pages are closed once the first task page exists');
    await initialPage.goto(`${origin}/set`);
    assert.match(await initialPage.locator('body').innerText(), /cookie set/);
    await first.close();
    first = null;

    second = await openPersistentBrowserProfile({ profileRoot, headless: true });
    const resumedPage = await second.context.newPage();
    await resumedPage.goto(`${origin}/read`);
    assert.match(await resumedPage.locator('body').innerText(), /roleforge_fixture_cookie=persisted-value/);
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});

test('a second process is refused while the persistent profile lock is held and close releases it', () => {
  const profileRoot = temporaryProfileRoot();
  const lock = acquireBrowserProfileLock({ profileRoot });
  try {
    const moduleUrl = new URL('../browser-profile.mjs', import.meta.url).href;
    const script = `
      import { acquireBrowserProfileLock } from ${JSON.stringify(moduleUrl)};
      try {
        acquireBrowserProfileLock();
        process.exitCode = 2;
      } catch (error) {
        if (/already in use/.test(error.message)) process.exitCode = 0;
        else { console.error(error.message); process.exitCode = 1; }
      }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, ROLEFORGE_BROWSER_PROFILE_ROOT: profileRoot },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.equal(JSON.parse(readFileSync(lock.lockPath, 'utf8')).pid, process.pid);
    assert.equal(lock.release(), true);
    assert.equal(existsSync(lock.lockPath), false);
    const reacquired = acquireBrowserProfileLock({ profileRoot });
    reacquired.release();
  } finally {
    lock.release();
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});

test('a stale lock is recovered only for a confirmed-gone local pid', () => {
  const profileRoot = temporaryProfileRoot();
  const paths = browserProfilePaths({ profileRoot });
  try {
    mkdirSync(profileRoot, { recursive: true });
    writeFileSync(paths.lockPath, `${JSON.stringify({
      pid: 2_000_000_000,
      startedAt: '2020-01-01T00:00:00.000Z',
      hostname: hostname(),
      token: 'stale-test-token',
    })}\n`);
    const recovered = acquireBrowserProfileLock({ profileRoot });
    assert.equal(JSON.parse(readFileSync(paths.lockPath, 'utf8')).pid, process.pid);
    assert.notEqual(JSON.parse(readFileSync(paths.lockPath, 'utf8')).token, 'stale-test-token');
    recovered.release();
  } finally {
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});

test('interleaved stale recovery cannot unlink a newly acquired live profile lock', () => {
  const profileRoot = temporaryProfileRoot();
  const { lockPath } = browserProfilePaths({ profileRoot });
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000,
    startedAt: '2020-01-01T00:00:00.000Z', hostname: hostname(), token: 'dead-owner' }));
  const originalRead = fs.readFileSync;
  let reads = 0;
  let contender;
  let refusal;
  let recovered;
  fs.readFileSync = (...args) => {
    const value = originalRead(...args);
    if (args[0] === lockPath && ++reads === 2) {
      // Return the stale final read after another recovery contender has tried
      // to remove it and acquire a live lock (the reviewer's exact interleave).
      try { contender = acquireBrowserProfileLock({ profileRoot }); } catch (error) { refusal = error; }
    }
    return value;
  };
  syncBuiltinESMExports();
  try {
    recovered = acquireBrowserProfileLock({ profileRoot });
    assert.match(refusal?.message || '', /recovery is already running/);
    assert.equal(contender, undefined);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).token, recovered.owner.token);
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    recovered?.release();
    contender?.release();
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});

test('stale recovery mutex requires manual deletion even for a confirmed-dead owner', () => {
  const profileRoot = temporaryProfileRoot();
  const recoveryPath = `${browserProfilePaths({ profileRoot }).lockPath}.recovery`;
  mkdirSync(profileRoot, { recursive: true });
  const owner = { pid: 2_000_000_000, startedAt: '2020-01-01T00:00:00.000Z', hostname: hostname(), token: 'dead-recovery' };
  try {
    writeFileSync(recoveryPath, JSON.stringify(owner));
    assert.throws(() => acquireBrowserProfileLock({ profileRoot }), /recovery is already running/);
    fs.utimesSync(recoveryPath, new Date(0), new Date(0));
    assert.throws(() => acquireBrowserProfileLock({ profileRoot }), error =>
      error.message.includes(recoveryPath) && /Delete this file manually.*no RoleForge browser/.test(error.message));
    assert.equal(JSON.parse(readFileSync(recoveryPath, 'utf8')).token, owner.token);
    writeFileSync(recoveryPath, JSON.stringify({ ...owner, pid: process.pid }));
    fs.utimesSync(recoveryPath, new Date(0), new Date(0));
    assert.throws(() => acquireBrowserProfileLock({ profileRoot }), /recovery is already running/);
  } finally { rmSync(join(profileRoot, '..'), { recursive: true, force: true }); }
});

test('a dead recovery mutex is never read or unlinked during the replacement interleave', () => {
  const profileRoot = temporaryProfileRoot();
  const recoveryPath = `${browserProfilePaths({ profileRoot }).lockPath}.recovery`;
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(recoveryPath, JSON.stringify({ pid: 2_000_000_000, startedAt: '2020-01-01T00:00:00.000Z',
    hostname: hostname(), token: 'dead-recovery' }));
  fs.utimesSync(recoveryPath, new Date(0), new Date(0));
  const originalRead = fs.readFileSync;
  const originalUnlink = fs.unlinkSync;
  let reads = 0;
  let deletes = 0;
  fs.readFileSync = (...args) => {
    const value = originalRead(...args);
    if (args[0] === recoveryPath && ++reads === 2) {
      writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(),
        hostname: hostname(), token: 'new-live-mutex-owner' }));
    }
    return value;
  };
  fs.unlinkSync = (...args) => { if (args[0] === recoveryPath) deletes++; return originalUnlink(...args); };
  syncBuiltinESMExports();
  try {
    assert.throws(() => acquireBrowserProfileLock({ profileRoot }), /Delete this file manually/);
    assert.equal(reads, 0);
    assert.equal(deletes, 0);
    assert.equal(JSON.parse(originalRead(recoveryPath, 'utf8')).token, 'dead-recovery');
  } finally {
    fs.readFileSync = originalRead;
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});

test('a visible persistent profile still opens a task page after its startup window is replaced', { skip: process.platform !== 'win32' && !process.env.DISPLAY }, async () => {
  const profileRoot = temporaryProfileRoot();
  let session;
  try {
    session = await openPersistentBrowserProfile({ profileRoot, headless: false });
    const page = await session.context.newPage();
    await page.goto('about:blank');
    assert.deepEqual(session.context.pages(), [page]);
  } finally {
    if (session) await session.close();
    rmSync(join(profileRoot, '..'), { recursive: true, force: true });
  }
});
