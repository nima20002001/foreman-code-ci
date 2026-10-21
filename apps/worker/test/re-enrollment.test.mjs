import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mockHostMounts, persistentHostMounts } from './fixtures/hostMounts.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';
import { managedRuntimeFixture } from './fixtures/managedRuntime.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { tsImport } = await import(require.resolve('tsx/esm/api'));
const { enrollWorkerCode, pairingErrorMessage } = await tsImport('../src/enrollment.mjs', import.meta.url);
const { ensurePairedManagedSetup } = await tsImport('../src/managedSetup.mjs', import.meta.url);
const { inspectManagedInstallation, pairingTarget } = await tsImport('../src/managedInstallation.mjs', import.meta.url);
const { openPrivateRoot } = await tsImport('../../api/src/modules/sources/privateFilesystem.ts', import.meta.url);
const { qualifyApprovedRootAllowlist } = await tsImport('../../api/src/modules/sources/rootAttestation.ts', import.meta.url);
const { encodeWorkerEnrollmentCode } = await tsImport('../../../packages/contracts/src/deviceSetup.ts', import.meta.url);
const { loadOrCreateWorkerIdentity, persistWorkerPairing, loadWorkerPairing, publicKeyFingerprint,
  mainEnrollmentProofMessage } = await tsImport('../../../packages/contracts/src/deviceIdentityNode.ts', import.meta.url);

async function fixture(t, { aliasedHome = false } = {}) {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'worker-re-enroll-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let home = directory;
  if (aliasedHome) {
    const target = join(await realpath(directory), 'home');
    await mkdir(target, { mode: 0o700 });
    home = join(directory, 'home-alias');
    await symlink(target, home);
  }
  const stateDirectory = join(home, 'state');
  const identity = await loadOrCreateWorkerIdentity(stateDirectory);
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const previous = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    endpoint: 'wss://main.example/device/connect', mainPublicKeyFingerprint: publicKeyFingerprint(publicKey),
    credential: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  await persistWorkerPairing(stateDirectory, previous);
  const enrollment = { mainId: previous.mainId, mainPublicKeyFingerprint: previous.mainPublicKeyFingerprint,
    endpoint: previous.endpoint, grant: 'g'.repeat(43), requestId: randomUUID() };
  const code = () => encodeWorkerEnrollmentCode({ version: 1, kind: 'enrollment',
    workerInstallationId: identity.workerInstallationId, publicKeyFingerprint: identity.publicKeyFingerprint,
    enrollment, expiresAt: '2099-01-01T00:00:00.000Z' });
  const registration = { mainId: previous.mainId, deviceId: previous.deviceId,
    workerInstallationId: identity.workerInstallationId, publicKeyFingerprint: identity.publicKeyFingerprint,
    keyRevision: 1, authorizationRevision: 3, status: 'paired', scopes: ['connect', 'heartbeat'] };
  const calls = [];
  const post = async (url, body) => {
    calls.push(url);
    if (url.endsWith('/device/challenge')) return { request: body, mainApplicationVersion: '1.0.0',
      mainPublicKey: publicKey, mainPublicKeyFingerprint: enrollment.mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainEnrollmentProofMessage(body, '1.0.0')), key.privateKey).toString('base64url') };
    return { registration, credential: 'b'.repeat(64), expiresAt: previous.expiresAt };
  };
  const enroll = () => enrollWorkerCode({ stateDirectory, identity, enrollmentCode: code(),
    appVersion: '1.0.0', home, post });
  return { home, stateDirectory, previous, enrollment, registration, calls, enroll };
}

test('same-Main re-enrollment replaces revoked credentials and refreshes managed runtime bindings', async t => {
  const f = await fixture(t);
  const identity = await readFile(join(f.stateDirectory, 'identity.json'));
  const result = await f.enroll();
  assert.equal(result.authorizationRevision, 3);
  const pairing = await loadWorkerPairing(f.stateDirectory);
  assert.equal(pairing.credential, 'b'.repeat(64));
  assert.equal(pairing.deviceId, f.previous.deviceId);
  const setup = JSON.parse(await readFile(join(f.stateDirectory, 'managed-setup.json'), 'utf8'));
  assert.equal(setup.status.state, 'runtime-unavailable');
  assert.equal(setup.target.registration.authorizationRevision, 3);
  assert.deepEqual(await readFile(join(f.stateDirectory, 'identity.json')), identity);
  assert.deepEqual(await f.enroll(), result);
});

test('re-enrollment cannot switch Main or replace the accepted device identity', async t => {
  const f = await fixture(t);
  f.enrollment.mainId = randomUUID();
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  f.enrollment.mainId = f.previous.mainId;
  f.registration.deviceId = randomUUID();
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  f.registration.deviceId = f.previous.deviceId;
  f.registration.authorizationRevision = 1;
  await assert.rejects(f.enroll());
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
});

test('re-enrollment waits for the existing Worker to stop before sending the grant', async t => {
  const f = await fixture(t);
  const unlock = await acquireWorkerLock(f.stateDirectory);
  try {
    await assert.rejects(f.enroll(), { code: 'worker_already_running' });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await loadWorkerPairing(f.stateDirectory), f.previous);
  } finally { await unlock(); }
});

async function provisionRuntime(f) {
  const setup = await ensurePairedManagedSetup({ stateDirectory: f.stateDirectory, pairing: f.previous, home: f.home });
  assert.equal(setup.state, 'runtime-unavailable');
  const installed = await managedRuntimeFixture({ home: f.home, state: f.stateDirectory,
    pairing: f.previous, worker: { qualifyApprovedRootAllowlist } });
  await writeFile(join(f.stateDirectory, 'ci-runtime-installation.json'), JSON.stringify({ schemaVersion: 1,
    target: pairingTarget(f.previous), runtime: installed.runtime }), { mode: 0o600 });
  return installed;
}

test('re-pairing adopts a stopped runtime with both bootstrap and executable configuration present', async t => {
  const f = await fixture(t);
  const installed = await provisionRuntime(f);
  const pairing = { ...f.previous, authorizationRevision: 3, credential: 'b'.repeat(64) };
  await persistWorkerPairing(f.stateDirectory, pairing);
  const options = { stateDirectory: f.stateDirectory, pairing, home: f.home,
    inspectInstallation: (installation, home) => inspectManagedInstallation(installation, home,
      { readQuota: installed.readQuota }) };
  const result = await ensurePairedManagedSetup(options);
  assert.equal(result.state, 'ready', result.message);
  assert.equal(result.migrated, true);
  const bootstrap = JSON.parse(await readFile(join(f.stateDirectory, 'ci-runtime-installation.json'), 'utf8'));
  assert.deepEqual(bootstrap.target, pairingTarget(pairing));
  assert.equal(bootstrap.runtime.machine.imageDigest, installed.runtime.machine.imageDigest);
  await assert.rejects(readFile(join(f.stateDirectory, 'job-runtime.json')), { code: 'ENOENT' });
  assert.deepEqual(await loadWorkerPairing(f.stateDirectory), pairing);
  assert.equal((await ensurePairedManagedSetup(options)).state, 'ready');
});

test('enrollment reports incomplete setup while retaining accepted pairing and original runtime selectors', async t => {
  const f = await fixture(t);
  const installed = await provisionRuntime(f);
  await writeFile(installed.runtime.seedReceiptPath, '{"changed":true}', { mode: 0o600 });
  await assert.rejects(f.enroll(), error => {
    assert.equal(error.code, 'managed_setup_incomplete');
    assert.match(pairingErrorMessage(error), /paired.*setup.*incomplete/i);
    return true;
  });
  const pairing = await loadWorkerPairing(f.stateDirectory);
  assert.equal(pairing.authorizationRevision, 3);
  assert.equal(pairing.credential, 'b'.repeat(64));
  const setup = JSON.parse(await readFile(join(f.stateDirectory, 'managed-setup.json'), 'utf8'));
  assert.equal(setup.status.state, 'failed');
  assert.deepEqual(JSON.parse(await readFile(join(f.stateDirectory, 'job-runtime.json'), 'utf8')), installed.runtime);
  const bootstrap = JSON.parse(await readFile(join(f.stateDirectory, 'ci-runtime-installation.json'), 'utf8'));
  assert.deepEqual(bootstrap.target, pairingTarget(f.previous));
});

test('re-pairing adopts a canonical runtime through a symlinked home and keeps private roots canonical', async t => {
  const f = await fixture(t, { aliasedHome: true });
  const canonicalHome = await realpath(f.home);
  const canonicalState = await realpath(f.stateDirectory);
  const installed = await provisionRuntime({ ...f, home: canonicalHome, stateDirectory: canonicalState });
  await assert.rejects(openPrivateRoot(f.stateDirectory), { code: 'SOURCE_FILESYSTEM_UNSUPPORTED' });
  const pairing = { ...f.previous, authorizationRevision: 3, credential: 'b'.repeat(64) };
  await persistWorkerPairing(f.stateDirectory, pairing);
  const options = { stateDirectory: f.stateDirectory, pairing, home: f.home,
    inspectInstallation: (installation, home) => inspectManagedInstallation(installation, home,
      { readQuota: installed.readQuota }) };
  const result = await ensurePairedManagedSetup(options);
  assert.equal(result.state, 'ready', result.message);
  assert.equal(result.migrated, true);
  const bootstrap = JSON.parse(await readFile(join(f.stateDirectory, 'ci-runtime-installation.json'), 'utf8'));
  assert.deepEqual(bootstrap.target, pairingTarget(pairing));
  assert.equal(bootstrap.runtime.descriptor.runtimeRoot, installed.runtime.descriptor.runtimeRoot);
  const approved = JSON.parse(await readFile(join(f.stateDirectory, 'approved-roots.json'), 'utf8'));
  for (const path of [approved.managedRuntimeRoot, ...approved.bases.map(base => base.canonicalPath)]) {
    assert.equal(path, await realpath(path));
    const root = await openPrivateRoot(path, false);
    await root.close();
  }
  assert.equal((await ensurePairedManagedSetup(options)).state, 'ready');
});
