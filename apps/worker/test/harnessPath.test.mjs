import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerPath } from '../src/harnessPath.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

async function fixture(t, scratch = persistentFixtureRoot) {
  const home = await mkdtemp(join(await realpath(scratch), 'worker-harness-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
async function nvm(home, version = 'v22.17.1') {
  const root = join(home, '.nvm/versions/node', version);
  const payload = join(root, 'lib/node_modules/@openai/codex/bin/codex.js');
  await mkdir(dirname(payload), { recursive: true });
  await mkdir(join(root, 'bin'));
  await writeFile(payload, '#!/usr/bin/env node\nconsole.log(process.version);', { mode: 0o775 });
  await symlink('../lib/node_modules/@openai/codex/bin/codex.js', join(root, 'bin/codex'));
  return { root, bin: join(root, 'bin'), payload };
}

test('discovers existing NVM npm symlinks while their env shebang uses pinned Node first', async (t) => {
  const home = await fixture(t), install = await nvm(home);
  await chmod(join(home, '.nvm'), 0o775);
  const path = workerPath(home, process.execPath);
  assert.equal(path.split(':')[0], dirname(process.execPath));
  assert.ok(path.split(':').includes(install.bin));
  const probe = spawnSync(join(install.bin, 'codex'), ['--version'], { env: { HOME: home, PATH: path }, cwd: home, encoding: 'utf8', timeout: 5000 });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), process.version);
});

test('missing executables and inherited empty, relative and arbitrary absolute PATH entries do not extend discovery', async (t) => {
  const home = await fixture(t), bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  const previous = process.env.PATH;
  t.after(() => { process.env.PATH = previous; });
  process.env.PATH = `:.:relative:${home}/untrusted`;
  const path = workerPath(home, process.execPath).split(':');
  assert.equal(path[0], dirname(process.execPath));
  assert.ok(!path.includes(bin));
  assert.ok(!path.includes('') && !path.includes('.') && !path.includes('relative'));
  assert.ok(!path.includes(`${home}/untrusted`));
  assert.equal(workerPath('relative/home', process.execPath), workerPath('/missing/home', process.execPath));
});

test('rejects world-writable installs, nonregular launchers and symlinks escaping home', async (t) => {
  const home = await fixture(t), install = await nvm(home);
  await chmod(install.payload, 0o777);
  assert.ok(!workerPath(home, process.execPath).split(':').includes(install.bin));
  await chmod(install.payload, 0o775);
  await chmod(join(home, '.nvm'), 0o777);
  assert.ok(!workerPath(home, process.execPath).split(':').includes(install.bin));
  const local = join(home, '.local/bin');
  await mkdir(join(local, 'codex'), { recursive: true });
  await symlink(process.execPath, join(local, 'claude'));
  assert.ok(!workerPath(home, process.execPath).split(':').includes(local));
});

test('discovers host-local Claude without admitting symlinked installation directories', async (t) => {
  const home = await fixture(t), bin = join(home, '.local/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  assert.ok(workerPath(home, process.execPath).split(':').includes(bin));
  const linkedHome = await fixture(t);
  await mkdir(join(linkedHome, '.local'));
  await symlink(bin, join(linkedHome, '.local/bin'));
  assert.ok(!workerPath(linkedHome, process.execPath).split(':').includes(join(linkedHome, '.local/bin')));
});

test('discovers canonical installations beneath a symlinked scratch ancestor while rejecting symlinked homes', async (t) => {
  const base = await fixture(t);
  const scratch = join(base, 'scratch');
  const alias = join(base, 'cache-link');
  await mkdir(scratch);
  await symlink(scratch, alias);
  const home = await fixture(t, alias);
  const install = await nvm(home);
  const aliasedHome = join(alias, basename(home));
  assert.equal(await realpath(aliasedHome), home);
  const path = workerPath(aliasedHome, process.execPath).split(':');
  assert.equal(path[0], dirname(process.execPath));
  assert.ok(path.includes(install.bin));
  assert.ok(!path.includes(join(aliasedHome, '.nvm/versions/node/v22.17.1/bin')));
  const linkedHome = join(base, 'home-link');
  await symlink(home, linkedHome);
  assert.ok(!workerPath(linkedHome, process.execPath).split(':').includes(install.bin));
});
