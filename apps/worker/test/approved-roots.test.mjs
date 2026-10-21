import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rename, rm, realpath } from 'node:fs/promises';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPairSync, randomUUID, createHash } from 'node:crypto';
import { mockHostMounts, persistentHostMounts } from './fixtures/hostMounts.mjs';
import { hostFacts } from '../src/diagnostics.mjs';

const artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
async function fixture(t, root = persistentFixtureRoot) {
  const { approvedRootExtensions, qualifyApprovedRootAllowlist } = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  // Synthetic unit configuration, never an installed host/approved application profile.
  const directory = await mkdtemp(join(await realpath(root), '.graphql-w07-root-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state'), base = join(directory, 'base'), runtime = join(directory, 'runtime');
  for (const path of [state, base, runtime, join(base, 'project')]) await mkdir(path, { mode: 0o700 });
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const installationId = randomUUID();
  const identity = { formatVersion: 1, workerInstallationId: installationId, keyRevision: 1, publicKey,
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyFingerprint: createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex') };
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://unit.example/device/connect', mainPublicKeyFingerprint: 'a'.repeat(64), credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  await writeFile(join(state, 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
  await writeFile(join(state, 'pairing.json'), JSON.stringify(pairing), { mode: 0o600 });
  const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId }, applicationInstallationId: installationId, configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-only'] }], managedRuntimeRoot: runtime });
  const file = join(state, 'approved-roots.json'); const bytes = JSON.stringify(allowlist);
  const save = () => writeFile(file, bytes, { mode: 0o600 });
  const bootId = randomUUID();
  const context = { binding: { mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1, bootId, connectionEpoch: randomUUID(), connectionGeneration: 1 }, signal: new AbortController().signal };
  const selection = { workspaceId: 'workspace-root-unit', hostRef: allowlist.hostRef, allowedBaseId: allowlist.bases[0].baseId, configurationRevision: '1', relativePath: 'project', accessMode: 'read-only', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 };
  return { approvedRootExtensions, state, base, pairing, allowlist, file, bytes, save, bootId, context, selection };
}

test('no approved configuration advertises no root handler; configured handler attests and browses actual fixture', { skip: !artifact }, async (t) => {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const f = await fixture(t);
  assert.deepEqual(await f.approvedRootExtensions(f.state, f.pairing, f.bootId), []);
  await f.save(); const [extension] = await f.approvedRootExtensions(f.state, f.pairing, f.bootId);
  assert.equal(extension.namespace, 'workspace-roots-v1'); assert.equal(extension.role, 'server'); assert.equal(extension.maxBinaryBytes, 0);
  const proof = await extension.handle({ version: 1, operation: 'workspace-roots.attest', selection: f.selection }, f.context);
  assert.equal(proof.payload.canonicalProjectRoot, join(f.base, 'project'));
  assert.equal(proof.payload.applicationInstallationId, f.pairing.workerInstallationId);
  const browse = await extension.handle({ version: 1, operation: 'workspace-roots.browse', selection: f.selection, relativePath: '' }, f.context);
  assert.deepEqual(browse.payload.directories, [{ name: 'project', relativePath: 'project' }]);
  await assert.rejects(extension.handle({ version: 1, operation: 'workspace-roots.attest', selection: { ...f.selection, relativePath: '../outside' } }, f.context), (error) => error.code === 'ROOT_RELATIVE_PATH_INVALID');
});

test('authentication and approved scope reject before corrupt config is read', { skip: !artifact }, async (t) => {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const f = await fixture(t); await f.save(); const [extension] = await f.approvedRootExtensions(f.state, f.pairing, f.bootId);
  await writeFile(f.file, 'corrupt');
  const request = { version: 1, operation: 'workspace-roots.attest', selection: f.selection };
  await assert.rejects(extension.handle(request, { ...f.context, binding: { ...f.context.binding, bootId: randomUUID() } }), /workspace_root_authentication_required/);
  await assert.rejects(extension.handle({ ...request, selection: { ...f.selection, allowedBaseId: randomUUID() } }, f.context), /workspace_root_scope_denied/);
  await assert.rejects(extension.handle({ ...request, selection: { ...f.selection, accessMode: 'read-write' } }, f.context), /workspace_root_scope_denied/);
  await assert.rejects(extension.handle(request, f.context), /approved_roots_configuration_invalid/);
});

test('private config, installation binding and exact filesystem identity fail closed without refresh', { skip: !artifact }, async (t) => {
  t.after(mockHostMounts(t.mock, persistentHostMounts));
  const f = await fixture(t); await f.save();
  await chmod(f.file, 0o644); await assert.rejects(f.approvedRootExtensions(f.state, f.pairing, f.bootId), /approved_roots_private_file_required/);
  await chmod(f.file, 0o600);
  await assert.rejects(f.approvedRootExtensions(f.state, { ...f.pairing, workerInstallationId: randomUUID() }, f.bootId), /approved_roots_identity_mismatch/);
  await rename(f.base, `${f.base}-old`); await mkdir(f.base, { mode: 0o700 });
  await assert.rejects(f.approvedRootExtensions(f.state, f.pairing, f.bootId), /approved_root_filesystem_mismatch/);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('packaged approved roots reject overlay host storage before advertising a handler', { skip: !artifact }, async t => {
  t.after(mockHostMounts(t.mock, '1 0 0:1 / / rw - overlay overlay rw\n'));
  const f = await fixture(t);
  await f.save();
  await assert.rejects(f.approvedRootExtensions(f.state, f.pairing, f.bootId), /approved_root_not_persistent/);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('packaged approved roots reject real tmpfs storage without rewriting configuration', { skip: !artifact }, async t => {
  const f = await fixture(t, '/dev/shm');
  await f.save();
  await assert.rejects(f.approvedRootExtensions(f.state, f.pairing, f.bootId), /approved_root_not_persistent/);
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});

test('packaged approved roots enforce actual host persistence for private configuration', { skip: !artifact }, async t => {
  const f = await fixture(t);
  await f.save();
  const facts = await hostFacts(process.env.HOME ?? '', [f.base, f.allowlist.managedRuntimeRoot]);
  if (facts.rootPersistent && facts.homePersistent && facts.storagePersistent) {
    const [extension] = await f.approvedRootExtensions(f.state, f.pairing, f.bootId);
    assert.equal(extension.namespace, 'workspace-roots-v1');
  } else {
    await assert.rejects(f.approvedRootExtensions(f.state, f.pairing, f.bootId), /approved_root_not_persistent/);
  }
  assert.equal(await readFile(f.file, 'utf8'), f.bytes);
});
