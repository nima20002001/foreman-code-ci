import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod, realpath, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setupCompanion } from '../src/setup.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.17.1', rootPersistent: true, homePersistent: true, storagePersistent: true };
async function fixture(t, artifactName = 'fixture') {
  const directory = await mkdtemp(join(await realpath(persistentFixtureRoot), 'worker-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home'), artifact = join(directory, 'artifact');
  await mkdir(home); await mkdir(join(artifact, 'src'), { recursive: true });
  const content = `console.log(JSON.stringify(process.argv.includes("capture-env") ? { artifact: ${JSON.stringify(artifactName)}, approvedNode: process.env.APPROVED_NODE_LABEL ?? null, path: process.env.PATH, node: process.execPath, nodeOptions: process.env.NODE_OPTIONS ?? null } : process.argv.slice(2)))`;
  await writeFile(join(artifact, 'src/cli.mjs'), content);
  await writeFile(join(artifact, 'src/companion.mjs'), content);
  await mkdir(join(artifact, 'artifacts'));
  const bridge = 'console.log("fixture authenticated MCP bridge")';
  await writeFile(join(artifact, 'artifacts/graphql-mcp.mjs'), bridge);
  const icon = await readFile(new URL('../../web/public/graphql.svg', import.meta.url));
  await writeFile(join(artifact, 'artifacts/graphql.svg'), icon);
  const manifest = { format: 1, version: '1.0.0', protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: facts,
    files: [...['cli.mjs', 'companion.mjs'].map((name) => ({ path: `src/${name}`, size: Buffer.byteLength(content), sha256: hash(content) })),
      { path: 'artifacts/graphql-mcp.mjs', size: Buffer.byteLength(bridge), sha256: hash(bridge) },
      { path: 'artifacts/graphql.svg', size: icon.length, sha256: hash(icon) }] };
  const bytes = JSON.stringify(manifest); await writeFile(join(artifact, 'manifest.json'), bytes);
  return { home, artifact, node: process.execPath, facts, approvedManifestSha256: hash(bytes), serviceTemplate: await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8') };
}

test('setup holds the installation lock until its launchers and proposed service are published', { timeout: 5000 }, async (t) => {
  const first = await fixture(t, 'first');
  const second = await fixture(t, 'second');
  const node = join(second.home, 'node-22.23.3');
  await writeFile(node, `#!/bin/sh\nexport APPROVED_NODE_LABEL=22.23.3\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  second.home = first.home;
  second.node = node;
  second.facts = { ...facts, node: 'v22.23.3' };
  const manifest = JSON.parse(await readFile(join(second.artifact, 'manifest.json'), 'utf8'));
  manifest.version = '1.1.0';
  manifest.target = second.facts;
  const bytes = JSON.stringify(manifest);
  await writeFile(join(second.artifact, 'manifest.json'), bytes);
  second.approvedManifestSha256 = hash(bytes);
  second.updatePolicy = async () => true;
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const write = fs.writeFile;
  let paused = false;
  const mocked = t.mock.method(fs, 'writeFile', async (path, ...options) => {
    if (!paused && String(path).startsWith(join(first.home, '.local/share/graphql/mcp/launcher.mjs.'))) {
      paused = true;
      entered.resolve();
      await resume.promise;
    }
    return write(path, ...options);
  });
  syncBuiltinESMExports();
  const pending = setupCompanion(first);
  try {
    await entered.promise;
    await assert.rejects(setupCompanion(second), /install_busy/);
  } finally {
    resume.resolve();
    await pending;
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  const installed = await setupCompanion(second);
  const previousUnit = await readFile(`${installed.proposedService}.previous`, 'utf8');
  assert.equal(previousUnit.match(/^ExecStart=(\S+) /m)[1], first.node);
  await setupCompanion(second);
  assert.equal(await readFile(`${installed.proposedService}.previous`, 'utf8'), previousUnit);
  const unit = await readFile(installed.proposedService, 'utf8');
  const [, serviceNode, entrypoint] = unit.match(/^ExecStart=(\S+) (\S+)/m);
  for (const [command, args] of [[installed.launcher, ['capture-env']], [serviceNode, [entrypoint, 'capture-env']]]) {
    const child = spawnSync(command, args, { encoding: 'utf8', timeout: 2000 });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.approvedNode, '22.23.3');
    assert.equal(report.artifact, 'second');
  }
});

test('setup installs private repeatable launcher files and retains existing identity without activating a service', async (t) => {
  const f = await fixture(t), state = join(f.home, '.local/state/graphql-worker');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'identity.json'), 'existing-private-identity', { mode: 0o600 });
  const result = await setupCompanion(f); await setupCompanion(f);
  assert.equal(await readFile(join(state, 'identity.json'), 'utf8'), 'existing-private-identity');
  for (const path of [result.root, result.state, result.launcher]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const path of [result.desktop, result.proposedService]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(result.serviceActivation, 'not-requested');
  assert.equal(result.appMcpLauncher, join(f.home, '.local/share/graphql/mcp/launcher.mjs'));
  const bridge = spawnSync(process.execPath, [result.appMcpLauncher], { encoding: 'utf8', timeout: 2000 });
  assert.equal(bridge.status, 0, bridge.stderr);
  assert.equal(bridge.stdout.trim(), 'fixture authenticated MCP bridge');
  assert.equal((await stat(result.appMcpLauncher)).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.home, '.local/share/graphql/mcp'))).mode & 0o777, 0o700);
  await assert.rejects(readFile(join(f.home, '.config/systemd/user/graphql-worker.service')), { code: 'ENOENT' });
  const run = spawnSync(result.launcher, ['doctor'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['--state', state, 'doctor']);
  assert.match(await readFile(result.launcher, 'utf8'), /unset NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED/);
  assert.match(await readFile(result.desktop, 'utf8'), /Terminal=false/);
  assert.match(await readFile(result.desktop, 'utf8'), / --desktop\n/);
  const iconPath = (await readFile(result.desktop, 'utf8')).match(/^Icon=(.+)$/m)[1];
  assert.deepEqual(await readFile(iconPath), await readFile(join(f.artifact, 'artifacts/graphql.svg')));
});

test('setup rejects checksum and nonprivate identity storage before publishing a launcher', async (t) => {
  const f = await fixture(t);
  await assert.rejects(setupCompanion({ ...f, approvedManifestSha256: 'c'.repeat(64) }), /manifest_checksum_mismatch/);
  await assert.rejects(readFile(join(f.home, '.local/lib/graphql-worker/graphql-companion')), { code: 'ENOENT' });
  const state = join(f.home, '.local/state/graphql-worker'); await chmod(state, 0o755);
  await assert.rejects(setupCompanion(f), /private_directory_required/);
});

test('reopening Companion follows the release selected by an automatic update', async t => {
  const first = await fixture(t, 'first');
  const second = await fixture(t, 'second');
  const installed = await setupCompanion(first);
  const replacement = join(installed.root, 'versions', 'replacement');
  await fs.cp(second.artifact, replacement, { recursive: true });
  const pointer = join(installed.root, 'incoming');
  await symlink(replacement, pointer);
  await rename(pointer, join(installed.root, 'current'));
  const result = spawnSync(installed.launcher, ['capture-env'], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).artifact, 'second');
});

test('generated launcher discovers NVM harnesses and filters the invoking environment', async (t) => {
  const f = await fixture(t), bin = join(f.home, '.nvm/versions/node/v22.17.1/bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'codex'), '#!/usr/bin/env node\nconsole.log(process.version)', { mode: 0o700 });
  const result = await setupCompanion(f);
  const run = spawnSync(result.launcher, ['capture-env'], { env: { PATH: ':relative:/untrusted', NODE_OPTIONS: '--invalid-option' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(run.status, 0, run.stderr);
  const environment = JSON.parse(run.stdout);
  assert.equal(environment.node, process.execPath);
  assert.equal(environment.nodeOptions, null);
  assert.ok(environment.path.split(':').includes(bin));
  assert.ok(!environment.path.includes('relative'));
  assert.match(await readFile(result.proposedService, 'utf8'), new RegExp(bin.replaceAll('.', '\\.')));
});
