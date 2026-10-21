import test, { before, after } from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, stat, symlink, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { mockHostMounts, persistentHostMounts } from './fixtures/hostMounts.mjs';
import { managedRuntimeFixture } from './fixtures/managedRuntime.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';

let artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
let artifactDirectory;

before(async () => {
  if (artifact) return;
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  artifactDirectory = await mkdtemp(join(persistentFixtureRoot, 'managed-worker-artifact-'));
  artifact = join(artifactDirectory, 'release');
  execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs',
    'apps/worker/artifacts/ubuntu-26.04-x64-target.json', artifact,
    'apps/worker/artifacts/node-22.23.3-linux-x64.json'],
  { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
});

after(async () => {
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
});

async function saveIdentity(state, workerInstallationId) {
  const keys = generateKeyPairSync('ed25519');
  const identity = { formatVersion: 1, workerInstallationId, keyRevision: 1,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  await writeFile(join(state, 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
}

async function fixture(t) {
  assert.ok(artifact, 'Managed setup tests require the committed Worker artifact');
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const home = await realpath(await mkdtemp(join(persistentFixtureRoot, 'managed-worker-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const worker = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const state = join(home, '.local/state/graphql-worker');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://fixture.invalid/device/connect', credential: 'a'.repeat(64),
    mainPublicKeyFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  await writeFile(join(state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  await saveIdentity(state, pairing.workerInstallationId);
  return { home, state, pairing, worker };
}

test('pairing prepares private managed roots and native journals without a roots approval file', async t => {
  const f = await fixture(t);
  const first = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  assert.equal(first.state, 'runtime-unavailable');
  const [extension] = await f.worker.approvedRootExtensions(f.state, f.pairing, randomUUID());
  assert.equal(extension.namespace, 'workspace-roots-v1');
  const approved = JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8'));
  assert.equal(approved.applicationInstallationId, f.pairing.workerInstallationId);
  assert.equal(approved.bases[0].managedBy, 'worker-pairing');
  for (const path of [approved.bases[0].canonicalPath, approved.managedRuntimeRoot]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  const second = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  assert.equal(second.state, 'runtime-unavailable');
  assert.deepEqual(JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8')), approved);
});

test('managed setup survives remount and reboot identities while advertising current mounts', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.state, pairing: f.pairing, home: f.home };
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'runtime-unavailable');
  const path = join(f.state, 'approved-roots.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(current.runtimeFilesystemId);
  assert.ok(current.bases.every(base => base.filesystemId));
  const previousIdentity = filesystem => ({ ...filesystem,
    device: String(BigInt(filesystem.device) + 1n), mountId: String(BigInt(filesystem.mountId) + 1000n) });
  const previous = { ...current,
    bases: current.bases.map(base => ({ ...base, filesystem: previousIdentity(base.filesystem) })),
    runtimeFilesystem: previousIdentity(current.runtimeFilesystem) };
  const bytes = JSON.stringify(previous);
  await writeFile(path, bytes, { mode: 0o600 });
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'runtime-unavailable');
  const bootId = randomUUID();
  const [extension] = await f.worker.approvedRootExtensions(f.state, f.pairing, bootId);
  const context = { binding: { ...f.pairing, bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 },
    signal: new AbortController().signal };
  const { payload } = await extension.handle({ version: 1, operation: 'workspace-roots.configuration' }, context);
  assert.deepEqual(payload, current);
  await assert.rejects(extension.handle({ version: 1, operation: 'workspace-roots.configuration' },
    { ...context, binding: { ...context.binding, bootId: randomUUID() } }), /workspace_root_authentication_required/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('managed setup adds persistent IDs to legacy approvals only after verifying their original identities', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.state, pairing: f.pairing, home: f.home };
  await f.worker.ensurePairedManagedSetup(options);
  const path = join(f.state, 'approved-roots.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  const legacy = structuredClone(current);
  delete legacy.runtimeFilesystemId;
  for (const base of legacy.bases) delete base.filesystemId;
  await writeFile(path, JSON.stringify(legacy), { mode: 0o600 });
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'runtime-unavailable');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), current);
  legacy.runtimeFilesystem.mountId = String(BigInt(legacy.runtimeFilesystem.mountId) + 1n);
  const bytes = JSON.stringify(legacy);
  await writeFile(path, bytes, { mode: 0o600 });
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'failed');
  await assert.rejects(f.worker.approvedRootExtensions(f.state, f.pairing, randomUUID()),
    /approved_root_filesystem_mismatch/);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('managed setup rejects replaced directories and filesystems without refreshing approved facts', async t => {
  const f = await fixture(t);
  const options = { stateDirectory: f.state, pairing: f.pairing, home: f.home };
  await f.worker.ensurePairedManagedSetup(options);
  const path = join(f.state, 'approved-roots.json');
  const current = JSON.parse(await readFile(path, 'utf8'));
  const changed = { ...current, runtimeFilesystemId: current.runtimeFilesystemId === '1' ? '2' : '1' };
  const bytes = JSON.stringify(changed);
  await writeFile(path, bytes, { mode: 0o600 });
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'failed');
  assert.equal(await readFile(path, 'utf8'), bytes);
  const original = JSON.stringify(current);
  await writeFile(path, original, { mode: 0o600 });
  await rename(current.managedRuntimeRoot, `${current.managedRuntimeRoot}-old`);
  await mkdir(current.managedRuntimeRoot, { mode: 0o700 });
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'failed');
  assert.equal(await readFile(path, 'utf8'), original);
});

test('pairing persists canonical managed roots through a symlinked storage ancestor', async t => {
  const f = await fixture(t);
  const alias = join(f.home, 'storage-alias');
  await symlink(join(f.home, '.local'), alias);
  const stateDirectory = join(alias, 'state/graphql-worker');
  const options = { stateDirectory, pairing: f.pairing, home: f.home };
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'runtime-unavailable');
  const approved = JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8'));
  assert.equal(approved.bases[0].canonicalPath, join(f.state, 'managed/workspaces'));
  assert.equal(approved.managedRuntimeRoot, join(f.state, 'managed/runtime'));
  const [extension] = await f.worker.approvedRootExtensions(stateDirectory, f.pairing, randomUUID());
  assert.equal(extension.namespace, 'workspace-roots-v1');
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'runtime-unavailable');
  assert.deepEqual(JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8')), approved);
});

test('automatic setup rejects a symlinked state directory before approving roots', async t => {
  const f = await fixture(t);
  const alias = join(f.home, 'state-alias');
  await symlink(f.state, alias);
  await assert.rejects(f.worker.ensurePairedManagedSetup({
    stateDirectory: alias, pairing: f.pairing, home: f.home,
  }), { code: 'private_directory_required' });
  await assert.rejects(readFile(join(f.state, 'approved-roots.json')), { code: 'ENOENT' });
});

test('automatic setup never follows a symlink or widens an owner directory', async t => {
  const f = await fixture(t);
  const outside = join(f.home, 'user-project');
  await mkdir(outside, { mode: 0o755 });
  await symlink(outside, join(f.state, 'managed'));
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  assert.equal(status.state, 'failed');
  assert.equal((await stat(outside)).mode & 0o777, 0o755);
  await assert.rejects(readFile(join(f.state, 'approved-roots.json')), { code: 'ENOENT' });
});

test('a missing established journal stays a recovery error on automatic retry', async t => {
  const f = await fixture(t);
  await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  await rm(join(f.state, 'job-runtime-operations.json'));
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  assert.equal(status.state, 'failed');
  assert.match(status.message, /journal is missing/);
  await assert.rejects(readFile(join(f.state, 'job-runtime-operations.json')), { code: 'ENOENT' });
});

async function previousInstallation(f) {
  const state = join(f.home, '.local/share/foreman-code/ci-verification/state');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const pairing = { ...f.pairing, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID() };
  await writeFile(join(state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  await saveIdentity(state, pairing.workerInstallationId);
  await f.worker.ensurePairedManagedSetup({ stateDirectory: state, pairing, home: f.home });
  const runtime = await managedRuntimeFixture({ home: f.home, state, pairing, worker: f.worker });
  return { state, pairing, ...runtime };
}

async function installQuotaObserver(old, script) {
  const executable = join(old.state, 'quota-observer');
  const bytes = `#!${process.execPath}\n${script}\n`;
  await writeFile(executable, bytes, { mode: 0o700 });
  const quotaPool = { ...old.runtime.descriptor.quotaPool, queryExecutable: executable,
    queryBinarySha256: createHash('sha256').update(bytes).digest('hex') };
  old.runtime = { ...old.runtime, descriptor: { ...old.runtime.descriptor, quotaPool },
    machine: { ...old.runtime.machine, quotaPool } };
  await writeFile(join(old.state, 'job-runtime.json'), JSON.stringify(old.runtime), { mode: 0o600 });
}

test('automatic adoption reads every installed quota through its pinned observer without sudo', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  const pool = old.runtime.descriptor.quotaPool;
  const observations = {};
  for (const slot of pool.slots) {
    const directory = join(old.runtime.root.binding.canonicalPath, slot.namespace);
    observations[directory] = await old.readQuota(pool, directory);
  }
  const reads = join(old.state, 'quota-reads.jsonl');
  await installQuotaObserver(old, `
const observations = ${JSON.stringify(observations)};
const observed = observations[process.argv[2]];
if (!observed || process.argv[3] !== ${JSON.stringify(pool.blockDevice)}) process.exit(1);
const { appendFileSync } = await import('node:fs');
appendFileSync(${JSON.stringify(reads)}, JSON.stringify(observed.projectId) + '\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(observed));`);
  const status = await f.worker.ensurePairedManagedSetup({
    stateDirectory: f.state, pairing: f.pairing, home: f.home,
  });
  assert.equal(status.state, 'ready');
  assert.equal(status.migrated, true);
  assert.deepEqual((await readFile(reads, 'utf8')).trim().split('\n').map(Number),
    pool.slots.map(slot => slot.projectId));
  const installed = JSON.parse(await readFile(join(f.state, 'ci-runtime-installation.json'), 'utf8'));
  assert.deepEqual(installed.runtime.descriptor.quotaPool, old.runtime.descriptor.quotaPool);
  assert.equal(installed.runtime.descriptor.runtimeRoot, old.runtime.descriptor.runtimeRoot);
  const approved = JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8'));
  assert.equal(approved.managedRuntimeRoot, old.runtime.descriptor.runtimeRoot);
  assert.equal(approved.hostRef.deviceId, f.pairing.deviceId);
});

test('a denied quota observer leaves the original installation available for a later retry', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  await installQuotaObserver(old, "process.stderr.write('read project quota: Operation not permitted\\n'); process.exit(1);");
  const status = await f.worker.ensurePairedManagedSetup({
    stateDirectory: f.state, pairing: f.pairing, home: f.home,
  });
  assert.equal(status.state, 'failed');
  assert.match(status.message, /JOB_QUOTA_UNAVAILABLE/);
  assert.equal(status.migrated, false);
  assert.deepEqual(JSON.parse(await readFile(join(old.state, 'job-runtime.json'), 'utf8')), old.runtime);
  assert.deepEqual(JSON.parse(await readFile(join(old.state, 'pairing.json'), 'utf8')), old.pairing);
  await assert.rejects(readFile(join(old.state, 'managed-retirement.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(f.state, 'ci-runtime-installation.json')), { code: 'ENOENT' });
});

test('automatic adoption rejects an installation without a quota pool and retains its selectors', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  delete old.runtime.descriptor.quotaPool;
  delete old.runtime.machine.quotaPool;
  await writeFile(join(old.state, 'job-runtime.json'), JSON.stringify(old.runtime), { mode: 0o600 });
  const status = await f.worker.ensurePairedManagedSetup({
    stateDirectory: f.state, pairing: f.pairing, home: f.home,
  });
  assert.equal(status.state, 'failed');
  assert.match(status.message, /managed_installation_quota_required/);
  assert.equal(status.migrated, false);
  assert.deepEqual(JSON.parse(await readFile(join(old.state, 'job-runtime.json'), 'utf8')), old.runtime);
  assert.deepEqual(JSON.parse(await readFile(join(old.state, 'approved-roots.json'), 'utf8')), old.approved);
  await assert.rejects(readFile(join(f.state, 'ci-runtime-installation.json')), { code: 'ENOENT' });
});

test('a new pairing adopts an idle managed runtime, retains image inputs and retires old access', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  await writeFile(join(old.state, 'workflow-runtime.json'), JSON.stringify({ schemaVersion: 1,
    codexBinary: '/retired/codex', expectedVersion: 'codex-cli 0.154.0', payloadPaths: [],
    appMcpLauncher: '/retired/launcher.mjs' }), { mode: 0o600 });
  const bootId = randomUUID();
  const [oldRoots] = await f.worker.approvedRootExtensions(old.state, old.pairing, bootId);
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home,
    inspectInstallation: (installation, home) => f.worker.inspectManagedInstallation(installation, home, { readQuota: old.readQuota }) });
  assert.equal(status.state, 'ready');
  assert.equal(status.migrated, true);
  const bin = join(f.home, 'bin');
  await mkdir(bin, { mode: 0o700 });
  execFileSync('/usr/bin/cc', ['-x', 'c', '-o', join(bin, 'codex'), '-'], {
    input: '#include <stdio.h>\nint main(void) { puts("codex-cli 0.162.0"); return 0; }\n',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const unlock = await acquireWorkerLock(f.state);
  try {
    await f.worker.refreshWorkflowSelection({ stateDirectory: f.state, environment: { PATH: bin },
      assertStateOwnership: unlock.assertOwned });
  } finally { await unlock(); }
  const selection = JSON.parse(await readFile(join(f.state, 'workflow-runtime.json'), 'utf8'));
  assert.equal(selection.codexBinary, join(bin, 'codex'));
  assert.equal(selection.appMcpLauncher, join(await realpath(artifact), 'artifacts/graphql-mcp.mjs'));
  await assert.rejects(readFile(join(old.state, 'workflow-runtime.json')), { code: 'ENOENT' });
  const installation = JSON.parse(await readFile(join(f.state, 'ci-runtime-installation.json'), 'utf8'));
  assert.equal(installation.target.hostRef.mainId, f.pairing.mainId);
  assert.equal(installation.target.registration.workerInstallationId, f.pairing.workerInstallationId);
  assert.equal(installation.runtime.machine.imageDigest, old.runtime.machine.imageDigest);
  assert.equal(installation.runtime.descriptor.runtimeRoot, old.runtime.descriptor.runtimeRoot);
  await assert.rejects(readFile(join(f.state, 'job-runtime.json')), { code: 'ENOENT' });
  await assert.rejects(oldRoots.handle({ version: 1, operation: 'workspace-roots.configuration' }, {
    binding: { ...old.pairing, bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 },
    signal: new AbortController().signal,
  }), { code: 'ENOENT' });
  const retry = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  assert.equal(retry.state, 'ready');
  assert.equal(retry.migrated, true);
  assert.equal(await readFile(old.runtime.seedReceiptPath, 'utf8'), '{}');
});

test('adoption waits for the old Worker and retries without retiring it while active', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  const unlock = await acquireWorkerLock(old.state);
  const options = { stateDirectory: f.state, pairing: f.pairing, home: f.home,
    inspectInstallation: (installation, home) => f.worker.inspectManagedInstallation(installation, home, { readQuota: old.readQuota }) };
  try {
    const status = await f.worker.ensurePairedManagedSetup(options);
    assert.equal(status.state, 'failed');
    assert.match(status.message, /previous Worker is still running/);
    assert.equal(JSON.parse(await readFile(join(old.state, 'pairing.json'), 'utf8')).mainId, old.pairing.mainId);
    const latest = { ...old.runtime, machine: { ...old.runtime.machine,
      imageDigest: `sha256:${'d'.repeat(64)}`, imageConfigDigest: `sha256:${'d'.repeat(64)}` } };
    await writeFile(join(old.state, 'job-runtime.json'), JSON.stringify(latest), { mode: 0o600 });
  } finally { await unlock(); }
  assert.equal((await f.worker.ensurePairedManagedSetup(options)).state, 'ready');
  const installation = JSON.parse(await readFile(join(f.state, 'ci-runtime-installation.json'), 'utf8'));
  assert.equal(installation.runtime.machine.imageDigest, `sha256:${'d'.repeat(64)}`);
});

test('managed roots are rebound after re-pairing even before a CI runtime exists', async t => {
  const f = await fixture(t);
  await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  const pairing = { ...f.pairing, mainId: randomUUID(), deviceId: randomUUID() };
  await writeFile(join(f.state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing, home: f.home });
  assert.equal(status.state, 'runtime-unavailable');
  const roots = JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8'));
  assert.equal(roots.hostRef.mainId, pairing.mainId);
  assert.equal(roots.bases.length, 1);
  assert.equal(roots.bases[0].managedBy, 'worker-pairing');
});

test('quota inspection failures retain their actionable code in persisted setup status', async t => {
  const f = await fixture(t);
  const old = await previousInstallation(f);
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home,
    inspectInstallation: (installation, home) => f.worker.inspectManagedInstallation(installation, home, {
      readQuota: async (...args) => {
        const value = await old.readQuota(...args);
        return { ...value, hardLimitBytes: value.hardLimitBytes + 1 };
      },
    }) });
  assert.equal(status.state, 'failed');
  assert.match(status.message, /JOB_QUOTA_CHANGED/);
  assert.equal(JSON.parse(await readFile(join(f.state, 'managed-setup.json'), 'utf8')).status.message, status.message);
});

test('re-pairing in the same state directory keeps the new identity and retires executable old selectors', async t => {
  const f = await fixture(t);
  await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  const old = await managedRuntimeFixture({ home: f.home, state: f.state, pairing: f.pairing, worker: f.worker });
  const pairing = { ...f.pairing, mainId: randomUUID(), deviceId: randomUUID(), authorizationRevision: 2 };
  await writeFile(join(f.state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  const status = await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing, home: f.home,
    inspectInstallation: (installation, home) => f.worker.inspectManagedInstallation(installation, home, { readQuota: old.readQuota }) });
  assert.equal(status.state, 'ready');
  assert.equal(status.migrated, true);
  assert.equal(JSON.parse(await readFile(join(f.state, 'pairing.json'), 'utf8')).mainId, pairing.mainId);
  const [extension] = await f.worker.approvedRootExtensions(f.state, pairing, randomUUID());
  assert.equal(extension.namespace, 'workspace-roots-v1');
  await assert.rejects(readFile(join(f.state, 'job-runtime.json')), { code: 'ENOENT' });
});

test('managed folder creation rejects arbitrary relative paths and an old Main', async t => {
  const f = await fixture(t);
  await f.worker.ensurePairedManagedSetup({ stateDirectory: f.state, pairing: f.pairing, home: f.home });
  const approved = JSON.parse(await readFile(join(f.state, 'approved-roots.json'), 'utf8'));
  const bootId = randomUUID();
  const [extension] = await f.worker.approvedRootExtensions(f.state, f.pairing, bootId);
  const selection = { workspaceId: 'workspace', hostRef: approved.hostRef,
    allowedBaseId: approved.bases[0].baseId, configurationRevision: approved.configurationRevision,
    relativePath: createHash('sha256').update('workspace').digest('hex'), accessMode: 'read-write',
    expectedLocationRevision: 1, expectedRootPolicyRevision: 0 };
  const context = { binding: { mainId: f.pairing.mainId, deviceId: f.pairing.deviceId,
    workerInstallationId: f.pairing.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 }, signal: new AbortController().signal };
  const request = { version: 1, operation: 'workspace-roots.prepare-managed', selection };
  await assert.rejects(extension.handle({ ...request, selection: { ...selection, relativePath: 'user-project' } }, context),
    { code: 'ROOT_ACCESS_DENIED' });
  await assert.rejects(extension.handle(request, { ...context, binding: { ...context.binding, mainId: randomUUID() } }),
    /workspace_root_authentication_required/);
  const response = await extension.handle(request, context);
  assert.equal(response.payload.applicationInstallationId, f.pairing.workerInstallationId);
  assert.equal((await stat(response.payload.canonicalProjectRoot)).mode & 0o777, 0o700);
  await chmod(join(f.state, 'approved-roots.json'), 0o644);
  await assert.rejects(extension.handle(request, context), /approved_roots_private_file_required/);
});
