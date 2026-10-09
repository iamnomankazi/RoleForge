import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    assert.equal(first.context.pages().length, 0, 'Chromium startup pages are closed before task pages are created');
    const initialPage = await first.context.newPage();
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
