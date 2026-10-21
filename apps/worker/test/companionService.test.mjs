import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { installVersion } from '../src/installation.mjs';
import { createCompanionService } from '../src/companionService.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'companion-service-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.local/lib/graphql-worker'), state = join(home, '.local/state/graphql-worker'), artifact = join(home, 'artifact');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const files = [{ path: 'src/cli.mjs', bytes: Buffer.from('console.log("reviewed-release")') }, { path: 'artifacts/graphql-worker.service.in', bytes: await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url)) }];
  for (const file of files) { await mkdir(join(artifact, file.path, '..'), { recursive: true }); await writeFile(join(artifact, file.path), file.bytes); }
  const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2', rootPersistent: true, homePersistent: true, storagePersistent: true };
  const manifest = { format: 1, version: '1.0.0', protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: facts, files: files.map(({ path, bytes }) => ({ path, sha256: hash(bytes), size: bytes.length })) };
  const bytes = JSON.stringify(manifest); await writeFile(join(artifact, 'manifest.json'), bytes);
  const installation = { root, stateDirectory: state, artifact, facts, approvedManifestSha256: hash(bytes), expected: { protocolVersion: 1, identityFormat: 1 } };
  await installVersion(installation);
  const calls = [];
  const service = createCompanionService({ home, stateDirectory: state, factsProvider: async () => facts, executeSystemctl: async (binary, args) => { calls.push({ binary, args }); }, ...options });
  return { home, root, state, service, calls, installation, manifest };
}

test('service preview is inert; enabling requires its exact verified plan and only invokes owned user-service commands', async (t) => {
  const f = await fixture(t), plan = await f.service.plan();
  assert.match(plan.unitText, /^NoNewPrivileges=no$/m);
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(plan.unitPath), { code: 'ENOENT' });
  await assert.rejects(f.service.enable('a'.repeat(64)), /service_plan_changed/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.service.enable(plan.planSha256), { enabled: true });
  assert.equal((await stat(plan.unitPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(plan.unitPath, 'utf8'), plan.unitText);
  assert.deepEqual(f.calls, [
    { binary: '/usr/bin/systemctl', args: ['--user', 'show', '--property=Version'] },
    { binary: '/usr/bin/systemctl', args: ['--user', 'daemon-reload'] },
    { binary: '/usr/bin/systemctl', args: ['--user', 'enable', '--now', 'graphql-worker.service'] },
  ]);
  assert.equal(plan.lingerAction, 'none');
});

test('activation serializes concurrent installation and starts the release in the reviewed plan', { timeout: 5000 }, async (t) => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let first = true;
  const launched = [];
  const f = await fixture(t, { executeSystemctl: async (_binary, args) => {
    if (first) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
    if (args.includes('enable')) {
      const unit = await readFile(join(f.home, '.config/systemd/user/graphql-worker.service'), 'utf8');
      const [, node, entrypoint] = unit.match(/^ExecStart=(\S+) (\S+)/m);
      const child = spawnSync(node, [entrypoint, 'run', '--state', f.state], { encoding: 'utf8', timeout: 2000 });
      assert.equal(child.status, 0, child.stderr);
      launched.push(child.stdout.trim());
    }
  } });
  const plan = await f.service.plan();
  const current = await readlink(join(f.root, 'current'));
  f.manifest.version = '1.1.0';
  const updatedCli = 'console.log("separately-approved-release")';
  await writeFile(join(f.installation.artifact, 'src/cli.mjs'), updatedCli);
  Object.assign(f.manifest.files.find(file => file.path === 'src/cli.mjs'), {
    size: Buffer.byteLength(updatedCli), sha256: hash(updatedCli),
  });
  const bytes = JSON.stringify(f.manifest);
  await writeFile(join(f.installation.artifact, 'manifest.json'), bytes);
  const update = { ...f.installation, approvedManifestSha256: hash(bytes), updatePolicy: async () => true };
  const activation = f.service.enable(plan.planSha256);
  try {
    await entered.promise;
    await assert.rejects(installVersion(update), /install_busy/);
    assert.equal(await readlink(join(f.root, 'current')), current);
  } finally {
    resume.resolve();
    await activation;
  }
  assert.equal(await readFile(plan.unitPath, 'utf8'), plan.unitText);
  assert.deepEqual(launched, ['reviewed-release']);
  await installVersion(update);
  await assert.rejects(f.service.enable(plan.planSha256), /service_plan_changed/);
});

test('rollback plan requires approval of the retained Node instead of selecting the current runtime', async (t) => {
  const f = await fixture(t);
  const currentFacts = { ...f.installation.facts, node: 'v22.23.3' };
  f.manifest.version = '1.1.0';
  f.manifest.target = currentFacts;
  const bytes = JSON.stringify(f.manifest);
  await writeFile(join(f.installation.artifact, 'manifest.json'), bytes);
  await installVersion({ ...f.installation, facts: currentFacts, approvedManifestSha256: hash(bytes),
    updatePolicy: async () => true });
  const service = createCompanionService({ home: f.home, stateDirectory: f.state, node: '/approved/current-node',
    factsProvider: async () => currentFacts });
  const plan = await service.plan();
  assert.equal(plan.rollbackAvailable, true);
  assert.equal(plan.rollbackRuntimeApprovalRequired, true);
  assert.equal(plan.rollbackCommands[1][0], 'APPROVED_RETAINED_NODE');
  assert.match(plan.rollbackPrerequisite, /v22\.23\.2/);
  assert.ok(!plan.rollbackCommands.flat().includes('/approved/current-node'));
  assert.deepEqual(f.calls, []);
});

test('tampered installed template cannot become a user service', async (t) => {
  const f = await fixture(t), plan = await f.service.plan();
  await writeFile(join(f.root, 'current/artifacts/graphql-worker.service.in'), '[Service]\nExecStart=/unapproved\n');
  await assert.rejects(f.service.enable(plan.planSha256), /artifact_checksum_mismatch/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(readFile(plan.unitPath), { code: 'ENOENT' });
});
