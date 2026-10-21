import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { chmod, mkdir, mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkBrowserRuntimeReadiness } from '../src/browserRuntimeInstall.mjs';
import { collectChromiumNotices } from '../../../scripts/browser-runtime-install.mjs';

async function deepEnvironment(t) {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'browser-paths-'));
  const deep = join(directory, 'nested-home-'.repeat(12), 'nested-runtime-'.repeat(10));
  await mkdir(deep, { recursive: true, mode: 0o700 });
  const previous = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = deep;
  process.env.TMPDIR = deep;
  t.after(async () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, deep };
}

async function singletonExchange(temporary) {
  const directory = await mkdtemp(join(temporary, 'org.chromium.Chromium.'));
  const path = join(directory, 'SingletonSocket');
  const server = createServer(socket => socket.end('owned browser'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    assert.equal((await lstat(path)).isSocket(), true);
    const reply = await new Promise((resolve, reject) => {
      const client = createConnection(path);
      client.once('error', reject);
      let received = '';
      client.on('data', bytes => { received += bytes; });
      client.once('end', () => resolve(received));
    });
    assert.equal(reply, 'owned browser');
  } finally {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

test('credits collection owns a usable private singleton socket despite deeply nested HOME and TMPDIR', async t => {
  const { directory, deep } = await deepEnvironment(t);
  let temporary, physical;
  const html = `<html>${'Copyright license text. '.repeat(80)}</html>`;
  await collectChromiumNotices('chromium', directory, directory, async (_command, _args, options) => {
    temporary = options.env?.TMPDIR ?? process.env.TMPDIR;
    physical = await realpath(temporary);
    assert.equal((await lstat(physical)).mode & 0o077, 0);
    await singletonExchange(temporary);
    return { stdout: html };
  });
  assert.equal(await readFile(join(directory, 'licenses/chromium-credits.html'), 'utf8'), html);
  assert.equal(process.env.TMPDIR, deep);
  await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  await assert.rejects(lstat(physical), { code: 'ENOENT' });
});

test('readiness uses and retires a private socket directory on success and probe failure with deep paths', async t => {
  const { directory, deep } = await deepEnvironment(t);
  const executable = join(directory, 'probe.mjs'), evidence = join(directory, 'probe.json');
  await writeFile(join(directory, 'manifest.json'), '{}');
  const program = `#!${process.execPath}
import { createServer } from 'node:net';
import { mkdtemp, lstat, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const temporary = process.env.TMPDIR;
const physical = await realpath(temporary);
if ((await lstat(physical)).mode & 0o077) throw new Error('Runtime directory is not private');
await writeFile(${JSON.stringify(evidence)}, JSON.stringify({ temporary, physical }));
const directory = await mkdtemp(join(temporary, 'org.chromium.Chromium.'));
const path = join(directory, 'SingletonSocket');
const server = createServer();
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
try { if (!(await lstat(path)).isSocket()) throw new Error('Singleton socket was not created'); }
finally { await new Promise(resolve => server.close(resolve)); }
`;
  const descriptor = { rootDirectory: directory, pythonExecutable: executable, chromiumExecutable: 'chromium' };
  for (const fails of [false, true]) {
    await writeFile(executable, program + (fails ? "throw new Error('Explicit probe failure');\n" : "console.log(JSON.stringify({ ready: true }));\n"), { mode: 0o700 });
    if (fails) await assert.rejects(checkBrowserRuntimeReadiness(descriptor), /Explicit probe failure/);
    else assert.deepEqual(await checkBrowserRuntimeReadiness(descriptor), { ready: true });
    const observed = JSON.parse(await readFile(evidence, 'utf8'));
    await assert.rejects(lstat(observed.temporary), { code: 'ENOENT' });
    await assert.rejects(lstat(observed.physical), { code: 'ENOENT' });
    assert.equal(process.env.TMPDIR, deep);
  }
});

test('readiness keeps its private runtime inside a shared cache parent without changing parent permissions', async t => {
  const { directory } = await deepEnvironment(t);
  const cache = join(directory, 'shared-cache'), unit = join(cache, 'unit');
  await mkdir(unit, { recursive: true, mode: 0o700 });
  await chmod(cache, 0o755);
  const executable = join(unit, 'probe.mjs');
  await writeFile(join(unit, 'manifest.json'), '{}');
  await writeFile(executable, `#!${process.execPath}
import { stat } from 'node:fs/promises';
if ((await stat(process.env.HOME)).mode & 0o077) throw new Error('Probe home is not private');
if ((await stat(process.env.TMPDIR)).mode & 0o077) throw new Error('Browser runtime is not private');
console.log(JSON.stringify({ ready: true }));
`, { mode: 0o700 });
  assert.deepEqual(await checkBrowserRuntimeReadiness({ rootDirectory: unit,
    pythonExecutable: executable, chromiumExecutable: 'chromium' }), { ready: true });
  assert.equal((await lstat(cache)).mode & 0o777, 0o755);
});
