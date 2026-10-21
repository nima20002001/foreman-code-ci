import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { createCompanionServer } from '../src/companionServer.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-http-'));
  const htmlFile = join(directory, 'companion.html');
  await writeFile(htmlFile, '<script nonce="{{CSP_NONCE}}"></script>');
  const calls = [];
  const gui = await createCompanionServer({ stateDirectory: directory, htmlFile, runCli: async (command, input) => {
    calls.push({ command, input });
    return command === 'identity-request' ? 'GQLWR1.public' : command === 'pair' ? '{}' : JSON.stringify({ pairing: 'unpaired', connection: 'offline', service: { active: false } });
  }, ...options });
  t.after(() => { gui.close(); return rm(directory, { recursive: true, force: true }); });
  const post = (path, body = {}, headers = {}) => fetch(`${gui.origin}${path}`, { method: 'POST', headers: { origin: gui.origin, 'content-type': 'application/json', 'x-graphql-companion-session': gui.session, ...headers }, body: JSON.stringify(body) });
  return { gui, calls, post };
}

test('loopback GUI requires its exact host, origin and session before executing any command', async (t) => {
  const f = await fixture(t);
  assert.match(f.gui.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: '' }]) assert.equal((await f.post('/api/status', {}, headers)).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const call = request(`${f.gui.origin}/api/status`, { method: 'POST', headers: { host: 'attacker.example', origin: f.gui.origin, 'x-graphql-companion-session': f.gui.session, 'content-type': 'application/json' } }, (response) => { response.resume(); resolve(response.statusCode); });
    call.on('error', reject); call.end('{}');
  });
  assert.equal(rejectedHost, 403);
  for (const token of ['', 'a'.repeat(43), 'é'.repeat(43)]) assert.equal((await f.post('/api/status', {}, { 'x-graphql-companion-session': token })).status, 401);
  assert.deepEqual(f.calls, []);
  const page = await fetch(f.gui.origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.equal(html.includes('{{CSP_NONCE}}'), false);
  assert.equal(html.includes(f.gui.session), false);
});

test('served companion page reads status through its session header', { timeout: 5000 }, async (t) => {
  const f = await fixture(t, { htmlFile: new URL('../artifacts/companion.html', import.meta.url) });
  const page = await fetch(f.gui.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const elements = new Map();
  const rendered = Promise.withResolvers();
  elements.set('state', {
    dataset: {},
    set textContent(value) { rendered.resolve(value); },
  });
  const getElementById = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        dataset: {},
        addEventListener() {},
        replaceChildren() {},
        append() {},
        toggleAttribute() {},
      });
    }
    return elements.get(id);
  };
  const location = new URL(f.gui.url);
  const statuses = [];
  // Execute the served client with DOM stubs and real HTTP requests.
  runInNewContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1], {
    URLSearchParams,
    location,
    history: {
      replaceState(_state, _title, path) { location.href = new URL(path, location).href; },
    },
    document: { getElementById, createElement: () => ({ style: {} }) },
    fetch: async (path, options) => {
      // Node fetch needs the origin that a browser sends automatically.
      const response = await fetch(new URL(path, f.gui.origin), {
        ...options,
        headers: { ...options.headers, origin: f.gui.origin },
      });
      statuses.push(response.status);
      return response;
    },
  });
  assert.equal(await rendered.promise, 'Unsupported');
  assert.deepEqual(statuses, [200]);
  assert.deepEqual(f.calls, [{ command: 'doctor', input: undefined }]);
  assert.equal(location.hash, '');
});

test('legacy session header authorizes identity, pairing and status requests', async (t) => {
  const f = await fixture(t);
  const identity = await f.post('/api/identity-request');
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { code: 'GQLWR1.public' });
  const paired = await f.post('/api/pair', { enrollmentCode: 'GQLWE1.private-test-code' });
  assert.equal(paired.status, 200);
  assert.deepEqual(await paired.json(), { paired: true });
  assert.deepEqual(f.calls, [{ command: 'identity-request', input: undefined }, { command: 'pair', input: 'GQLWE1.private-test-code' }]);
  const statusResponse = await f.post('/api/status');
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.service.active, false);
  assert.equal(status.serviceControl, 'human-only-confirmation');
  assert.equal((await f.post('/api/service', { enabled: true })).status, 404);
  assert.equal((await f.post('/api/pair', { enrollmentCode: 'x'.repeat(8193) })).status, 400);
  assert.equal((await f.post('/api/pair', { enrollmentCode: 'x'.repeat(17000) })).status, 413);
  assert.equal(f.calls.length, 3);
});

test('closing the GUI ends its session without issuing worker or service commands', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.post('/api/close')).json(), { closed: true });
  assert.deepEqual(f.calls, []);
  await assert.rejects(fetch(`${f.gui.origin}/`));
});

test('service enable is separate from pairing, requires explicit confirmation and actual paired readback', async (t) => {
  const enables = []; let paired = false;
  const f = await fixture(t, { runCli: async () => JSON.stringify({ pairing: paired ? 'paired' : 'unpaired' }), serviceController: { plan: async () => ({ planSha256: 'a'.repeat(64) }), enable: async (sha) => { enables.push(sha); return { enabled: true }; } } });
  assert.deepEqual(await (await f.post('/api/service-plan')).json(), { planSha256: 'a'.repeat(64) });
  assert.equal((await f.post('/api/service-enable', { planSha256: 'a'.repeat(64) })).status, 400);
  assert.equal((await f.post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).status, 400);
  assert.deepEqual(enables, []);
  paired = true;
  assert.deepEqual(await (await f.post('/api/service-enable', { confirm: true, planSha256: 'a'.repeat(64) })).json(), { enabled: true });
  assert.deepEqual(enables, ['a'.repeat(64)]);
});

test('GUI sessions expire and separate launches get different credentials', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const first = await fixture(t, { lifetimeMs: 50 }), second = await fixture(t);
    assert.notEqual(first.gui.session, second.gui.session);
    t.mock.timers.tick(50);
    await assert.rejects(fetch(first.gui.origin));
    assert.equal((await second.post('/api/status')).status, 200);
  } finally {
    t.mock.timers.reset();
  }
});

test('read-only preview cannot create identity, pair or change a service', async (t) => {
  const f = await fixture(t, { readOnly: true });
  for (const path of ['/api/identity-request', '/api/pair', '/api/service-enable']) assert.equal((await f.post(path, { enrollmentCode: 'GQLWE1.test', confirm: true, planSha256: 'a'.repeat(64) })).status, 403);
  assert.deepEqual(f.calls, []);
  const status = await (await f.post('/api/status')).json();
  assert.equal(status.readOnly, true);
  assert.equal(status.compatibility.supported, false);
});

test('a session spanning an installed target change reports the new target and denies installation actions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'companion-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'app');
  const first = join(root, 'release-a');
  const second = join(root, 'release-b');
  await mkdir(first, { recursive: true, mode: 0o700 });
  await mkdir(second, { mode: 0o700 });
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2' };
  await writeFile(join(first, 'manifest.json'), JSON.stringify({ target }));
  const nextTarget = { ...target, node: 'v22.23.3' };
  await writeFile(join(second, 'manifest.json'), JSON.stringify({ target: nextTarget }));
  await symlink('release-a', join(root, 'current'));
  const commands = [];
  const f = await fixture(t, {
    manifestFile: join(first, 'manifest.json'),
    installationRoot: root,
    runCli: async (command) => {
      commands.push(command);
      return JSON.stringify({ versions: target, pairing: 'paired', service: { active: false } });
    },
    serviceController: {
      plan: async () => { throw new Error('stale session must not plan'); },
      enable: async () => { throw new Error('stale session must not enable'); },
    },
  });
  const initial = await (await f.post('/api/status')).json();
  assert.equal(initial.compatibility.supported, true);
  await symlink('release-b', join(root, '.next'));
  await rename(join(root, '.next'), join(root, 'current'));
  const status = await (await f.post('/api/status')).json();
  assert.equal(status.installationChanged, true);
  assert.equal(status.compatibility.supported, false);
  assert.deepEqual(status.compatibility.required, nextTarget);
  for (const path of ['/api/identity-request', '/api/pair', '/api/service-plan', '/api/service-enable']) {
    const response = await f.post(path, { enrollmentCode: 'GQLWE1.private', confirm: true, planSha256: 'a'.repeat(64) });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'companion_installation_changed' });
  }
  assert.deepEqual(commands, ['doctor', 'doctor']);
});
