import { readdir, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ApprovedRootAllowlistSchema } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
import { WorkerPairingConfigurationSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { InstalledVerificationRuntimeConfigurationSchema, MAX_VERIFICATION_CONFIGURATION_BYTES }
  from '../../../apps/api/src/modules/jobs/installedVerificationConfiguration.ts';
import { fingerprintQualificationPath } from '../../../apps/api/src/modules/jobs/qualification.ts';
import { readVerificationQuotaPool } from '../../../apps/api/src/modules/jobs/quotaOwnership.ts';
import { readProtectedRuntimeFile } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';
import { anchored, identity, openPrivateRoot, openChildDirectory }
  from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { readPrivateBytes, assertRuntimeQuiescent } from './jobRuntimeCapture.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { optionalManagedJson, publishManagedJson } from './managedState.mjs';
import { hostFacts, WorkerError } from './diagnostics.mjs';

export function pairingTarget(pairing) {
  return { hostRef: { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId },
    registration: { workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
      authorizationRevision: pairing.authorizationRevision }, mainInstallationId: pairing.mainId };
}

export function samePairingTarget(left, right) {
  return JSON.stringify(pairingTarget(left)) === JSON.stringify(pairingTarget(right));
}

async function installationCandidates(home, stateDirectory) {
  const candidates = [join(home, '.local/share/foreman-code/ci-verification/state')];
  const archivePath = join(home, 'foreman-artifacts');
  let archive;
  try { archive = await openPrivateRoot(archivePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (archive) {
    try {
      const names = (await readdir(anchored(archive))).filter(name => /^graphql-worker-state-\d{8}$/.test(name)).sort().reverse();
      if (names.length > 32) throw new WorkerError('managed_installation_inventory_too_large');
      candidates.push(...names.map(name => join(archivePath, name)));
    } finally { await archive.close(); }
  }
  return [stateDirectory, ...candidates.filter(path => path !== stateDirectory)];
}

export async function discoverManagedInstallation(home, stateDirectory, currentPairing) {
  for (const path of await installationCandidates(home, stateDirectory)) {
    let directory;
    try { directory = await openPrivateRoot(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    try {
      const raw = await optionalManagedJson(directory, 'job-runtime.json', MAX_VERIFICATION_CONFIGURATION_BYTES);
      if (!raw || raw.schemaVersion !== 2) continue;
      const runtime = InstalledVerificationRuntimeConfigurationSchema.parse(raw);
      const roots = ApprovedRootAllowlistSchema.parse(await optionalManagedJson(directory, 'approved-roots.json'));
      const current = WorkerPairingConfigurationSchema.parse(await optionalManagedJson(directory, 'pairing.json'));
      const target = runtime.descriptor.target;
      if (path === stateDirectory && JSON.stringify(target) === JSON.stringify(pairingTarget(currentPairing))) continue;
      if (target.hostRef.kind !== 'device' || !target.registration) throw new WorkerError('managed_installation_identity_mismatch');
      const pairing = { mainId: target.hostRef.mainId, deviceId: target.hostRef.deviceId, ...target.registration };
      const allowedRuntimeRoots = [join(home, '.local/share/foreman-code/ci-verification/volume/managed'),
        join(home, '.local/share/graphql-ci/volume/managed'), join(stateDirectory, 'managed/runtime')];
      if (!allowedRuntimeRoots.includes(roots.managedRuntimeRoot) || runtime.descriptor.runtimeRoot !== roots.managedRuntimeRoot
        || roots.applicationInstallationId !== pairing.workerInstallationId
        || roots.hostRef.kind !== 'device' || roots.hostRef.mainId !== pairing.mainId || roots.hostRef.deviceId !== pairing.deviceId
        || JSON.stringify(runtime.descriptor.target) !== JSON.stringify(pairingTarget(pairing))
        || path !== stateDirectory && !samePairingTarget(current, pairing)) {
        throw new WorkerError('managed_installation_identity_mismatch');
      }
      const publicPairing = { mainId: pairing.mainId, deviceId: pairing.deviceId,
        workerInstallationId: pairing.workerInstallationId, keyRevision: pairing.keyRevision,
        authorizationRevision: pairing.authorizationRevision };
      return { stateDirectory: path, pairing: publicPairing, runtime };
    } finally { await directory.close(); }
  }
  return null;
}

export async function inspectManagedInstallation(installation, home, { readQuota } = {}) {
  const runtime = installation.runtime;
  const descriptor = runtime.descriptor;
  const paths = [installation.stateDirectory, descriptor.runtimeRoot, runtime.root.binding.canonicalPath];
  const facts = await hostFacts(home, paths);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) {
    throw new WorkerError('managed_installation_not_persistent');
  }
  if (runtime.root.binding.canonicalPath !== join(descriptor.runtimeRoot, 'source-materializations', runtime.root.selection.rootPolicyId)
    || !runtime.qualificationSource.directory.startsWith(`${descriptor.runtimeRoot}/installer/`)) {
    throw new WorkerError('managed_installation_path_mismatch');
  }
  const productStorage = [join(home, '.local/share/foreman-code/ci-verification'), join(home, '.local/share/graphql-ci'),
    installation.stateDirectory];
  if (!productStorage.some(base => runtime.seedReceiptPath.startsWith(`${base}/`))) {
    throw new WorkerError('managed_installation_path_mismatch');
  }
  const receipt = await readProtectedRuntimeFile({ path: runtime.seedReceiptPath, ownerUid: process.getuid() }, 16 * 1024 * 1024);
  if (createHash('sha256').update(receipt).digest('hex') !== runtime.seedReceiptSha256) {
    throw new WorkerError('managed_installation_seed_changed');
  }
  for (const [path, expected] of [[descriptor.runtimeExecutable, runtime.machine.runtimeBinarySha256],
    [descriptor.ociExecutable, runtime.machine.ociBinarySha256], [descriptor.findmntExecutable, descriptor.findmntBinarySha256]]) {
    if ((await fingerprintQualificationPath(path, true)).sha256 !== expected) {
      throw new WorkerError('managed_installation_binary_changed');
    }
  }
  const source = await openPrivateRoot(runtime.root.binding.canonicalPath);
  try {
    const filesystem = await identity(source);
    if (filesystem.device !== runtime.root.binding.filesystem.device || filesystem.inode !== runtime.root.binding.filesystem.inode) {
      throw new WorkerError('managed_installation_source_changed');
    }
    const pool = descriptor.quotaPool;
    if (!pool) throw new WorkerError('managed_installation_quota_required');
    const slots = [];
    for (const slot of pool.slots) {
      const child = await openChildDirectory(source, slot.namespace);
      try {
        const observed = await identity(child);
        if (observed.device !== slot.filesystem.device || observed.inode !== slot.filesystem.inode) {
          throw new WorkerError('managed_installation_quota_changed');
        }
        slots.push({ ...slot, filesystem: observed });
      } finally { await child.close(); }
    }
    const quotaPool = { ...pool, slots };
    const root = { ...runtime.root, binding: { ...runtime.root.binding, filesystem } };
    await readVerificationQuotaPool(quotaPool, root.binding, AbortSignal.timeout(30_000), readQuota);
    return InstalledVerificationRuntimeConfigurationSchema.parse({ ...runtime, root,
      descriptor: { ...descriptor, quotaPool }, machine: { ...runtime.machine, quotaPool } });
  } finally { await source.close(); }
}

/** Both installations are stopped or locked before retiring the old connection and runtime selectors. */
export async function retireManagedInstallation(installation, target, state,
  { assertStateOwnership, home, inspectInstallation = inspectManagedInstallation } = {}) {
  const stateDirectory = await realpath(anchored(state));
  const sameState = installation.stateDirectory === stateDirectory;
  const unlock = sameState ? null : await acquireWorkerLock(installation.stateDirectory);
  const previous = await openPrivateRoot(installation.stateDirectory);
  try {
    await assertRuntimeQuiescent(installation.stateDirectory, sameState ? assertStateOwnership : unlock.assertOwned);
    const current = await optionalManagedJson(previous, 'pairing.json');
    if (current && !sameState && !samePairingTarget(current, installation.pairing)) {
      throw new WorkerError('managed_installation_pairing_changed');
    }
    const retired = await optionalManagedJson(previous, 'managed-retirement.json');
    if (retired && JSON.stringify(retired.target) !== JSON.stringify(target)) {
      throw new WorkerError('managed_installation_pairing_changed');
    }
    const live = await optionalManagedJson(previous, 'job-runtime.json', MAX_VERIFICATION_CONFIGURATION_BYTES);
    if (live) {
      const runtime = InstalledVerificationRuntimeConfigurationSchema.parse(live);
      const roots = ApprovedRootAllowlistSchema.parse(await optionalManagedJson(previous, 'approved-roots.json'));
      if (JSON.stringify(runtime.descriptor.target) !== JSON.stringify(pairingTarget(installation.pairing))
        || runtime.descriptor.runtimeRoot !== installation.runtime.descriptor.runtimeRoot
        || roots.managedRuntimeRoot !== runtime.descriptor.runtimeRoot
        || roots.applicationInstallationId !== installation.pairing.workerInstallationId) {
        throw new WorkerError('managed_installation_identity_mismatch');
      }
      installation = { ...installation, runtime: await inspectInstallation({ ...installation, runtime }, home) };
      await publishManagedJson(state, 'managed-adoption.json', installation);
    }
    await publishManagedJson(state, 'ci-runtime-installation.json', { schemaVersion: 1,
      target, runtime: installation.runtime });
    if (!sameState) {
      await publishManagedJson(previous, 'managed-retirement.json', { schemaVersion: 1, target,
        adoptedByStateDirectory: stateDirectory, retiredAt: new Date().toISOString() });
    }
    // Retain runtime bytes for recovery, outside the selectors an old Worker can read.
    const archive = await openChildDirectory(previous, 'retired-runtime', true);
    try {
      for (const name of (await readdir(anchored(previous))).filter(name => /^job-runtime(?:-[a-f0-9]{64})?\.json$/.test(name)
        || name === 'approved-roots.json' || name === 'workflow-runtime.json')) {
        const bytes = await readPrivateBytes(previous, name, MAX_VERIFICATION_CONFIGURATION_BYTES);
        const digest = createHash('sha256').update(bytes).digest('hex');
        await publishManagedJson(archive, `${name}-${digest}`, JSON.parse(bytes.toString('utf8')));
        await unlink(anchored(previous, name));
      }
      if (current && !sameState) await unlink(anchored(previous, 'pairing.json'));
      await previous.sync();
    } finally { await archive.close(); }
  } finally {
    await previous.close();
    await unlock?.();
  }
}
