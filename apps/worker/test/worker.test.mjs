import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readlink, rm, symlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { loadOrCreateWorkerIdentity, persistWorkerPairing, loadWorkerPairing } =
  await tsImport('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url);
import { installVersion, rollbackVersion, requireReleaseState } from '../src/installation.mjs';
import { doctorReport, persistentFilesystems } from '../src/diagnostics.mjs';
import { startWorker, readWorkerStatus, acquireWorkerLock } from '../src/runtime.mjs';
import { renderUserService } from '../src/service.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2', rootPersistent: true, homePersistent: true };
const expected = { protocolVersion: 1, identityFormat: 1 };
async function fixture(t, version = '1.0.0') {
  const dir = await mkdtemp(join(tmpdir(), 'worker-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateDirectory = join(dir, 'installation-state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const artifact = join(dir, 'artifact'); await mkdir(join(artifact, 'src'), { recursive: true });
  const content = 'export const workerOnly = true;\n';
  await writeFile(join(artifact, 'src/cli.mjs'), content);
  const manifest = { format: 1, version, protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: facts, files: [{ path: 'src/cli.mjs', size: Buffer.byteLength(content), sha256: hash(content) }] };
  const save = async () => { const bytes = JSON.stringify(manifest); await writeFile(join(artifact, 'manifest.json'), bytes); return hash(bytes); };
  const approvedManifestSha256 = await save();
  return { root: join(dir, 'app'), stateDirectory, artifact, facts, expected, approvedManifestSha256, manifest, save, dir };
}

test('updates reject another state directory while the installed worker remains running', async (t) => {
  const f = await fixture(t);
  await installVersion(f);
  const current = await readlink(join(f.root, 'current'));
  const otherState = join(f.dir, 'other-state');
  await mkdir(otherState, { mode: 0o700 });
  await requireReleaseState({ directory: join(f.root, 'current'), stateDirectory: f.stateDirectory });
  await assert.rejects(requireReleaseState({ directory: join(f.root, 'current'), stateDirectory: otherState }),
    /installation_state_mismatch/);
  const unlock = await acquireWorkerLock(f.stateDirectory);
  try {
    f.manifest.version = '1.1.0';
    f.approvedManifestSha256 = await f.save();
    await assert.rejects(installVersion({ ...f, stateDirectory: otherState, updatePolicy: async () => true }),
      /installation_state_mismatch/);
    await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), /worker_already_running/);
    assert.equal(await readlink(join(f.root, 'current')), current);
    assert.equal((await readWorkerStatus(f.stateDirectory)).active, true);
  } finally {
    await unlock();
  }
});

test('an installed root without a recorded state binding fails closed', async (t) => {
  const f = await fixture(t);
  await installVersion(f);
  const current = await readlink(join(f.root, 'current'));
  await rm(join(f.root, 'state-directory.json'));
  await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), /installation_state_unbound/);
  assert.equal(await readlink(join(f.root, 'current')), current);
});

test('different source commits with an unchanged package version cannot silently replace a release', async (t) => {
  const f = await fixture(t, '0.1.0');
  await installVersion(f);
  const current = await readlink(join(f.root, 'current'));
  f.manifest.commit = 'c'.repeat(40);
  f.approvedManifestSha256 = await f.save();
  await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), /release_order_unknown/);
  assert.equal(await readlink(join(f.root, 'current')), current);
});

test('product releases reject an older update', async (t) => {
  const f = await fixture(t, '0.0.55');
  await installVersion(f);
  const current = await readlink(join(f.root, 'current'));
  f.manifest.version = '0.0.54';
  f.manifest.commit = 'c'.repeat(40);
  f.approvedManifestSha256 = await f.save();
  await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), /downgrade_refused/);
  assert.equal(await readlink(join(f.root, 'current')), current);
});

test('rollback requires the retained target runtime and leaves the current link intact on mismatch', async (t) => {
  const f = await fixture(t);
  await installVersion(f);
  const first = await readlink(join(f.root, 'current'));
  const nextFacts = { ...facts, node: 'v22.23.3' };
  f.manifest.version = '1.1.0';
  f.manifest.target = nextFacts;
  f.approvedManifestSha256 = await f.save();
  await installVersion({ ...f, facts: nextFacts, updatePolicy: async () => true });
  const current = await readlink(join(f.root, 'current'));
  const rollback = { root: f.root, stateDirectory: f.stateDirectory, expected, approveStop: async () => true };
  await assert.rejects(rollbackVersion({ ...rollback, facts: nextFacts }), /target_runtime_mismatch/);
  assert.equal(await readlink(join(f.root, 'current')), current);
  await rollbackVersion({ ...rollback, facts });
  assert.equal(await readlink(join(f.root, 'current')), first);
});

test('verified update and rollback preserve identity outside versions; repeated install is idempotent', async (t) => {
  const f = await fixture(t);
  const identity = await loadOrCreateWorkerIdentity(f.stateDirectory);
  const pairing = { formatVersion: 1, mainId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222', workerInstallationId: identity.workerInstallationId,
    keyRevision: identity.keyRevision, authorizationRevision: 1, endpoint: 'ws://127.0.0.1/carrier',
    mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2126-01-01T00:00:00Z' };
  await persistWorkerPairing(f.stateDirectory, pairing);
  const records = await Promise.all(['identity.json', 'pairing.json']
    .map(name => readFile(join(f.stateDirectory, name))));
  const assertIdentity = async () => {
    assert.deepEqual(await Promise.all(['identity.json', 'pairing.json']
      .map(name => readFile(join(f.stateDirectory, name)))), records);
    assert.deepEqual(await loadOrCreateWorkerIdentity(f.stateDirectory), identity);
    assert.deepEqual(await loadWorkerPairing(f.stateDirectory), pairing);
  };
  await installVersion(f); await installVersion(f);
  await assertIdentity();
  const first = await readlink(join(f.root, 'current'));
  f.manifest.version = '1.1.0'; f.approvedManifestSha256 = await f.save();
  await assert.rejects(installVersion(f), /update_not_approved/);
  await installVersion({ ...f, updatePolicy: async () => true });
  await assertIdentity();
  assert.notEqual(await readlink(join(f.root, 'current')), first);
  await rollbackVersion({ root: f.root, stateDirectory: f.stateDirectory, approveStop: async () => true, facts, expected });
  assert.equal(await readlink(join(f.root, 'current')), first);
  await assertIdentity();
});

test('bad manifest checksum and modified file leave current untouched', async (t) => {
  const f = await fixture(t);
  await assert.rejects(installVersion({ ...f, approvedManifestSha256: 'c'.repeat(64) }), /manifest_checksum_mismatch/);
  await writeFile(join(f.artifact, 'src/cli.mjs'), 'tampered');
  await assert.rejects(installVersion(f), /artifact_checksum_mismatch/);
  await assert.rejects(readlink(join(f.root, 'current')), { code: 'ENOENT' });
});

test('wrong arch, libc, Node, protocol and ephemeral storage reject before install', async (t) => {
  const f = await fixture(t);
  for (const [key, value] of [['arch', 'arm64'], ['libc', 'musl'], ['node', 'v24.0.0']]) await assert.rejects(installVersion({ ...f, facts: { ...facts, [key]: value } }), /target_runtime_mismatch/);
  await assert.rejects(installVersion({ ...f, expected: { ...expected, protocolVersion: 2 } }), /protocol_or_identity_unsupported/);
  await assert.rejects(installVersion({ ...f, facts: { ...facts, homePersistent: false } }), /nonpersistent_storage/);
});

test('concurrent update serialized and downgrade refused', async (t) => {
  const f = await fixture(t); await installVersion(f);
  f.manifest.version = '2.0.0'; f.approvedManifestSha256 = await f.save();
  let release; let entered;
  const started = new Promise((r) => { entered = r; });
  const pending = installVersion({ ...f, updatePolicy: () => { entered(); return new Promise((r) => { release = r; }); } });
  await started;
  await assert.rejects(installVersion(f), /install_busy/);
  release(true); await pending;
  f.manifest.version = '1.9.0'; f.approvedManifestSha256 = await f.save();
  await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), /downgrade_refused/);
});

test('symlink artifact and interrupted staging are rejected without publication', async (t) => {
  const f = await fixture(t);
  await rm(join(f.artifact, 'src/cli.mjs'));
  await symlink('/etc/passwd', join(f.artifact, 'src/cli.mjs'));
  await assert.rejects(installVersion(f), /artifact_file_invalid/);
  await assert.rejects(readlink(join(f.root, 'current')), { code: 'ENOENT' });
});

test('partial staging failure leaves installed version intact and removes own staging', async (t) => {
  const f = await fixture(t); await installVersion(f);
  const first = await readlink(join(f.root, 'current'));
  f.manifest.version = '1.1.0';
  f.manifest.files.push({ path: 'src/missing.mjs', size: 1, sha256: 'e'.repeat(64) });
  f.approvedManifestSha256 = await f.save();
  await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), { code: 'ENOENT' });
  assert.equal(await readlink(join(f.root, 'current')), first);
  assert.equal((await readdir(join(f.root, 'versions'))).some((name) => name.startsWith('.stage-')), false);
});

test('killed updater leaves current intact and releases the install lock for retry', async (t) => {
  const f = await fixture(t); await installVersion(f);
  const first = await readlink(join(f.root, 'current'));
  f.manifest.version = '1.1.0'; f.approvedManifestSha256 = await f.save();
  const source = new URL('../src/installation.mjs', import.meta.url).href;
  const options = { root: f.root, stateDirectory: f.stateDirectory, artifact: f.artifact, facts, expected, approvedManifestSha256: f.approvedManifestSha256 };
  const code = `import {installVersion} from ${JSON.stringify(source)};
    await installVersion({...${JSON.stringify(options)},updatePolicy:()=>{process.stdout.write('locked');return new Promise(()=>setInterval(()=>{},1000))}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data');
  const rollback = { root: f.root, stateDirectory: f.stateDirectory, facts, expected, approveStop: async () => true };
  await assert.rejects(installVersion(f), /install_busy/);
  await assert.rejects(rollbackVersion(rollback), /install_busy/);
  assert.equal(await readlink(join(f.root, 'current')), first);
  const closed = once(child, 'close');
  child.kill('SIGKILL');
  await closed;
  assert.equal(await readlink(join(f.root, 'current')), first);
  await assert.rejects(installVersion(f), /update_not_approved/);
  await installVersion({ ...f, updatePolicy: async () => true });
  assert.notEqual(await readlink(join(f.root, 'current')), first);
  await rollbackVersion(rollback);
  assert.equal(await readlink(join(f.root, 'current')), first);
});

test('read-only app root permits idempotent install but rejects a version change', async (t) => {
  const f = await fixture(t); await installVersion(f);
  const first = await readlink(join(f.root, 'current'));
  await chmod(f.root, 0o500);
  try {
    await installVersion(f);
    assert.equal(await readlink(join(f.root, 'current')), first);
    f.manifest.version = '1.1.0';
    f.approvedManifestSha256 = await f.save();
    await assert.rejects(installVersion({ ...f, updatePolicy: async () => true }), { code: 'EACCES' });
    assert.equal(await readlink(join(f.root, 'current')), first);
  } finally {
    await chmod(f.root, 0o700);
  }
});

test('rollback verifies retained bytes and cannot reactivate tampered code', async (t) => {
  const f = await fixture(t); await installVersion(f);
  const first = await readlink(join(f.root, 'current'));
  f.manifest.version = '1.1.0'; f.approvedManifestSha256 = await f.save();
  await installVersion({ ...f, updatePolicy: async () => true });
  const current = await readlink(join(f.root, 'current'));
  await writeFile(join(f.root, first, 'src/cli.mjs'), 'tampered');
  await assert.rejects(rollbackVersion({ root: f.root, stateDirectory: f.stateDirectory, approveStop: async () => true, facts, expected }), /artifact_checksum_mismatch/);
  assert.equal(await readlink(join(f.root, 'current')), current);
});

test('worker duplicate start, stable OS boot identity across restart, and graceful stop', async (t) => {
  const f = await fixture(t); const state = join(f.dir, 'state'); await mkdir(state, { mode: 0o700 });
  const identity = { workerInstallationId: 'stable' }; let starts = 0; let stops = 0;
  const options = { stateDirectory: state, loadIdentity: async () => identity, createConnection: async ({ capabilities }) => { assert.deepEqual(capabilities, { dispatch: false, transfer: false }); return { start() { starts++; }, async stop() { stops++; } }; } };
  const first = await startWorker(options);
  t.after(() => first.stop());
  assert.equal((await readWorkerStatus(state)).active, true);
  await assert.rejects(startWorker(options), /worker_already_running/);
  await Promise.all([first.stop(), first.stop()]);
  const second = await startWorker(options); t.after(() => second.stop());
  assert.equal(second.identity, first.identity); assert.equal(second.bootId, first.bootId);
  await second.stop(); assert.equal(starts, 2); assert.equal(stops, 2);
});

test('private state permissions fail closed', async (t) => {
  const f = await fixture(t); const state = join(f.dir, 'state'); await mkdir(state, { mode: 0o700 });
  await chmod(state, 0o755);
  await assert.rejects(startWorker({ stateDirectory: state, loadIdentity: async () => ({}), createConnection: async () => ({ start() {}, stop() {} }) }), /private_directory_required/);
});

test('shutdown timeout fences duplicate start until process termination, with no stale PID lock', async (t) => {
  const f = await fixture(t); const state = join(f.dir, 'state'); await mkdir(state, { mode: 0o700 });
  const source = new URL('../src/runtime.mjs', import.meta.url).href;
  const code = `import assert from 'node:assert/strict'; import {startWorker} from ${JSON.stringify(source)};
    const options = {stateDirectory:${JSON.stringify(state)},loadIdentity:async()=>({}),createConnection:async()=>({start(){},stop(){return new Promise(()=>{})}}),shutdownMs:5};
    const worker=await startWorker(options); await assert.rejects(worker.stop(),/shutdown_timeout/);
    await assert.rejects(startWorker(options),/worker_already_running/); process.exit(0);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readWorkerStatus(state), null);
  const worker = await startWorker({ stateDirectory: state, loadIdentity: async () => ({}), createConnection: async () => ({ start() {}, stop() {} }) });
  await worker.stop();
});

test('doctor projects allowlisted fields and recognizes overlay or ephemeral home', () => {
  const mounts = '1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /home rw - tmpfs tmpfs rw';
  assert.deepEqual(persistentFilesystems(mounts, '/home/user'), { rootPersistent: true, homePersistent: false });
  assert.deepEqual(persistentFilesystems('1 0 0:1 / / rw - overlay /cow rw', '/home/user'), { rootPersistent: false, homePersistent: false });
  const report = doctorReport({ facts, identity: { workerInstallationId: 'id', privateKey: 'SECRET', token: 'SECRET' }, connection: { state: 'blocked', providerLogs: 'SECRET' }, service: { active: false, userManagerAvailable: false, args: 'SECRET' }, executables: {}, errors: ['systemd_user_manager_missing', 'SECRET'] });
  assert.equal(JSON.stringify(report).includes('SECRET'), false);
  assert.deepEqual(report.errors, ['systemd_user_manager_missing']);
});

test('service absolute paths, controlled environment and bounded cgroup shutdown', async () => {
  const template = await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8');
  const fields = { node: '/usr/bin/node', app: '/home/user/.local/lib/graphql-worker', state: '/home/user/.local/state/graphql-worker', home: '/home/user', path: '/usr/bin:/bin' };
  assert.match(template, /UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_TLS_REJECT_UNAUTHORIZED/);
  const rendered = renderUserService(template, fields);
  assert.match(rendered, /^Delegate=cpu memory pids$/m);
  assert.match(rendered, /^NoNewPrivileges=no$/m);
  assert.match(rendered, /^UMask=0077$/m);
  assert.match(rendered, /KillMode=control-group/); assert.match(rendered, /TimeoutStopSec=15/); assert.doesNotMatch(rendered, /@|sudo|linger/);
  assert.throws(() => renderUserService(template, { ...fields, home: '/home/%u' }), /service_path_invalid/);
});
