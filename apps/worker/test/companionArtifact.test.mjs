import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
for (const [storage, directory, persistent] of [['tmpfs', '/dev/shm', false], ['persistent', persistentFixtureRoot, true]]) {
test(`packaged GUI serves CSP and keeps doctor read-only on ${storage} storage`, { skip: !artifact }, async (t) => {
  const manifest = JSON.parse(await readFile(join(artifact, 'manifest.json'), 'utf8'));
  assert.equal((await stat(join(artifact, 'install'))).mode & 0o777, 0o700);
  const { createCompanionServer } = await import(pathToFileURL(join(artifact, 'src/companionServer.mjs')).href);
  if (!persistent) assert.equal((await statfs(directory)).type, 0x01021994);
  const state = await mkdtemp(join(directory, 'packaged-companion-'));
  const home = await mkdtemp(join(persistentFixtureRoot, 'packaged-harness-home-'));
  const bin = join(home, '.nvm/versions/node/v22.17.1/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'codex'), '#!/usr/bin/env node\nconsole.log(process.version)', { mode: 0o700 });
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previousHome; return rm(home, { recursive: true, force: true }); });
  const gui = await createCompanionServer({ stateDirectory: state });
  t.after(() => { gui.close(); return rm(state, { recursive: true, force: true }); });
  const page = await fetch(gui.origin), html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<title>Foreman Code Companion<\/title>/);
  assert.equal(html.includes('{{CSP_NONCE}}'), false);
  assert.equal(html.includes(gui.session), false);
  assert.match(html, /\/api\/service-plan/);
  assert.match(html, /\/api\/service-enable/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const post = (path, body = {}, origin = gui.origin) => fetch(`${gui.origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-graphql-companion-session': gui.session }, body: JSON.stringify(body) });
  assert.equal((await post('/api/identity-request', {}, 'https://outside.example')).status, 403);
  const status = await (await post('/api/status')).json();
  assert.equal(status.versions.commit, manifest.commit);
  assert.equal(status.pairing, 'unpaired');
  assert.equal(status.executables.codex, true);
  assert.equal(status.service.active, false);
  assert.equal(status.persistentState, persistent);
  await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
  assert.deepEqual(status.compatibility.required, manifest.target);
  assert.deepEqual(status.compatibility.actual, Object.fromEntries(['os', 'osRelease', 'arch', 'libc', 'node'].map((key) => [key, status.versions[key]])));
  assert.equal(status.compatibility.supported, status.compatibility.mismatches.length === 0);
  assert.equal((await post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).status, 400);
  // Identity also requires the package's exact approved target runtime.
  const persistentHost = status.persistentRoot && status.persistentHome && status.persistentState;
  const canInitialize = persistentHost && status.compatibility.supported;
  const identity = await post('/api/identity-request');
  assert.equal(identity.status, canInitialize ? 200 : 400);
  if (canInitialize) assert.equal((await stat(join(state, 'identity.json'))).mode & 0o777, 0o600);
  else {
    const error = persistentHost ? 'target_runtime_mismatch' : 'companion_command_failed';
    assert.deepEqual(await identity.json(), { error });
    await assert.rejects(readFile(join(state, 'identity.json')), { code: 'ENOENT' });
  }
});
}
