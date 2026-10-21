import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { installVersion, stageRunningVersion } from '../src/installation.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { WorkerUpdater } = await tsImport('../src/update.mjs', import.meta.url);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };
const expected = { protocolVersion: 1, identityFormat: 1 };

async function artifact(base, version) {
  const directory = join(base, version);
  await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
  const content = `console.log(JSON.stringify({ version: '${version}', args: process.argv.slice(2),
    approvedNode: process.env.APPROVED_NODE_LABEL, nodeOptions: process.env.NODE_OPTIONS ?? null }));`;
  const files = [];
  for (const name of ['cli.mjs', 'companion.mjs']) {
    const path = `src/${name}`;
    await writeFile(join(directory, path), content, { mode: 0o600 });
    files.push({ path, size: Buffer.byteLength(content), sha256: hash(content) });
  }
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version, protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: { os, osRelease, arch, libc, node }, files };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(directory, 'manifest.json'), bytes, { mode: 0o600 });
  return { artifact: directory, approvedManifestSha256: hash(bytes) };
}

test('update staging migrates an installed pinned Companion launcher and preserves its approved environment', async t => {
  const parent = join(homedir(), '.cache/foreman-tmp');
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(join(parent, 'companion-launcher-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'app');
  const stateDirectory = join(base, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const options = { root, stateDirectory, facts, expected, updatePolicy: async () => true };
  const previous = await installVersion({ ...options, ...await artifact(base, '1.0.0') });
  const node = join(base, 'approved-node');
  await writeFile(node, `#!/bin/sh\nexport APPROVED_NODE_LABEL=approved\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o700 });
  const launcher = join(root, 'graphql-companion');
  await writeFile(launcher, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED\nexport HOME='${base}'\nexport PATH='/usr/bin:/bin'\nexec '${node}' '${previous.directory}/src/companion.mjs' --state '${stateDirectory}' "$@"\n`,
    { mode: 0o700 });
  const launch = () => {
    const result = spawnSync(launcher, ['doctor'], { encoding: 'utf8', timeout: 2000,
      env: { ...process.env, NODE_OPTIONS: '--invalid-option' } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(launch().version, '1.0.0');
  const incoming = await artifact(base, '1.1.0');
  const unlock = await acquireWorkerLock(stateDirectory);
  try {
    const staged = await stageRunningVersion({ ...options, ...incoming, assertStateOwnership: unlock.assertOwned });
    assert.equal(launch().version, '1.0.0');
    const pointer = join(root, 'incoming');
    await symlink(relative(root, staged.directory), pointer);
    await rename(pointer, join(root, 'current'));
    const report = launch();
    assert.equal(report.version, '1.1.0');
    assert.deepEqual(report.args, ['--state', stateDirectory, 'doctor']);
    assert.equal(report.approvedNode, 'approved');
    assert.equal(report.nodeOptions, null);
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);
    const migrated = await readFile(launcher);
    await stageRunningVersion({ ...options, ...incoming, assertStateOwnership: unlock.assertOwned });
    assert.deepEqual(await readFile(launcher), migrated);
  } finally { await unlock(); }
});

for (const aliasedHome of [false, true]) {
  test(`updater startup migrates a pinned launcher with ${aliasedHome ? 'a symlinked' : 'a canonical'} home`, async t => {
    const parent = join(homedir(), '.cache/foreman-tmp');
    await mkdir(parent, { recursive: true });
    const directory = await realpath(await mkdtemp(join(parent, 'companion-startup-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const home = join(directory, 'home');
    await mkdir(home, { mode: 0o700 });
    const alias = join(directory, 'home-alias');
    await symlink(home, alias);
    const base = aliasedHome ? alias : home;
    const root = join(base, 'app');
    const stateDirectory = join(base, 'state');
    await mkdir(stateDirectory, { mode: 0o700 });
    const options = { root, stateDirectory, facts, expected, updatePolicy: async () => true };
    const previous = await installVersion({ ...options, ...await artifact(base, '1.0.0') });
    const launcher = join(root, 'graphql-companion');
    await writeFile(launcher, `#!/bin/sh\nexec '${process.execPath}' '${previous.directory}/src/companion.mjs' "$@"\n`,
      { mode: 0o700 });
    const installed = await installVersion({ ...options, ...await artifact(base, '1.1.0') });
    const unlock = await acquireWorkerLock(stateDirectory);
    try {
      const updater = await new WorkerUpdater({ stateDirectory, facts, version: installed.version,
        manifestSha256: installed.manifestSha256, releaseDirectory: installed.directory,
        assertStateOwnership: unlock.assertOwned }).initialize();
      t.after(() => updater.close());
      const result = spawnSync(launcher, ['doctor'], { encoding: 'utf8', timeout: 2000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).version, '1.1.0');
    } finally { await unlock(); }
  });
}
