import { constants } from 'node:fs';
import { open, lstat, link, unlink, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { WorkerPairingConfigurationSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { publicKeyFingerprint } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { InstalledJobRuntimeCaptureInputRecordSchema, InstalledJobRuntimeConfigurationRecordSchema,
  InstalledJobRuntimeRefreshInputSchema, captureInstalledRuntimeConfigurationRecord } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';
import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { NativeProcessRegistry } from '../../../apps/api/src/modules/harnesses/recovery/processRegistry.ts';
import { openPrivateRoot, anchored } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { hostFacts, WorkerError } from './diagnostics.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { loadApprovedRoots } from './approvedRoots.mjs';

export async function readPrivateBytes(parent, name, maximumBytes = 65536) {
  const file = await open(anchored(parent, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid() || before.mode & 0o077 || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes) throw new WorkerError('job_runtime_private_input_required');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new WorkerError('job_runtime_input_changed');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new WorkerError('job_runtime_input_changed');
    return bytes;
  } finally { await file.close(); }
}
export async function readPrivateJson(parent, name, maximumBytes = 65536) {
  return JSON.parse((await readPrivateBytes(parent, name, maximumBytes)).toString('utf8'));
}

export async function assertRuntimeQuiescent(stateDirectory, assertExclusiveOwner) {
  for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
    const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { assertExclusiveOwner });
    try { await journal.assertRuntimeQuiescent(); } finally { await journal.close(); }
  }
  for (const name of ['workflow-native-processes', 'job-runtime-native-processes']) {
    const registry = new NativeProcessRegistry(join(stateDirectory, name));
    if (registry.snapshot().launches.some(launch => launch.lifecycle !== 'closed')) {
      throw new WorkerError('job_runtime_recovery_required');
    }
  }
}

async function preserveConfiguration(state, name, bytes) {
  const temporary = anchored(state, `.job-runtime-${randomUUID()}`);
  const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try { await staged.writeFile(bytes); await staged.sync(); } finally { await staged.close(); }
    try { await link(temporary, anchored(state, name)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await readPrivateBytes(state, name, 2 * 1024 * 1024 + 65536)).equals(bytes)) {
        throw new WorkerError('job_runtime_configuration_conflict', undefined, { cause: error });
      }
    }
    await state.sync();
  } finally { await unlink(temporary); }
}

/** Human-reviewed installer configuration only. No identity creation, journal initialization,
 * qualification, execution, or caller-selected overwrite path. */
export async function captureJobRuntime(stateDirectory, inputPath) {
  return publishJobRuntime(stateDirectory, inputPath, 'capture');
}
export async function refreshJobRuntime(stateDirectory, inputPath) {
  return publishJobRuntime(stateDirectory, inputPath, 'refresh');
}
async function publishJobRuntime(stateDirectory, inputPath, operation) {
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const state = await openPrivateRoot(stateDirectory);
  let unlock;
  try {
    unlock = await acquireWorkerLock(stateDirectory);
    const output = anchored(state, 'job-runtime.json');
    const existing = await lstat(output).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && operation === 'capture') throw new WorkerError('job_runtime_configuration_exists');
    if (!existing && operation === 'refresh') throw new WorkerError('job_runtime_configuration_missing');
    const identity = await readPrivateJson(state, 'identity.json');
    const pairing = WorkerPairingConfigurationSchema.parse(await readPrivateJson(state, 'pairing.json'));
    if (identity.formatVersion !== 1 || identity.workerInstallationId !== pairing.workerInstallationId || identity.keyRevision !== pairing.keyRevision
      || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
      || publicKeyFingerprint(createPublicKey(identity.privateKey).export({ type: 'spki', format: 'pem' }).toString()) !== identity.publicKeyFingerprint) throw new WorkerError('identity_invalid');
    const inputParent = await openPrivateRoot(dirname(inputPath), false);
    let input, previousBytes, previousConfigurationPath;
    try {
      const inputBytes = await readPrivateBytes(inputParent, basename(inputPath), 2 * 1024 * 1024 + 65536);
      const raw = JSON.parse(inputBytes.toString('utf8'));
      if (operation === 'refresh') {
        const reviewed = InstalledJobRuntimeRefreshInputSchema.parse(raw);
        previousBytes = await readPrivateBytes(state, 'job-runtime.json', 2 * 1024 * 1024 + 65536);
        InstalledJobRuntimeConfigurationRecordSchema.parse(JSON.parse(previousBytes.toString('utf8')));
        const digest = createHash('sha256').update(previousBytes).digest('hex');
        if (digest !== reviewed.expectedConfigurationSha256) throw new WorkerError('job_runtime_configuration_conflict');
        await assertRuntimeQuiescent(stateDirectory, unlock.assertOwned);
        previousConfigurationPath = join(stateDirectory, `job-runtime-${digest}.json`);
        input = reviewed.captureInput;
      } else {
        if (raw.schemaVersion !== 2 && inputBytes.length > 65536) throw new WorkerError('job_runtime_private_input_required');
        input = InstalledJobRuntimeCaptureInputRecordSchema.parse(raw);
      }
    }
    finally { await inputParent.close(); }
    const target = input.schemaVersion === 2 ? input.descriptor.target : input.target;
    const runtimeRoot = input.schemaVersion === 2 ? input.descriptor.runtimeRoot : input.runtimeRoot;
    if (target.hostRef.kind !== 'device' || target.hostRef.mainId !== pairing.mainId || target.hostRef.deviceId !== pairing.deviceId
      || target.mainInstallationId !== pairing.mainId || target.registration?.workerInstallationId !== pairing.workerInstallationId
      || target.registration.keyRevision !== pairing.keyRevision || target.registration.authorizationRevision !== pairing.authorizationRevision) throw new WorkerError('job_runtime_identity_mismatch');
    const approved = await loadApprovedRoots(stateDirectory, pairing);
    if (!approved) throw new WorkerError('job_runtime_root_unavailable');
    const policyId = input.root.selection.rootPolicyId;
    if (basename(policyId) !== policyId || policyId === '.' || policyId === '..'
      || runtimeRoot !== approved.managedRuntimeRoot
      || input.root.binding.canonicalPath !== join(approved.managedRuntimeRoot, 'source-materializations', policyId)
      || input.root.binding.filesystem.device !== approved.runtimeFilesystem.device
      || input.root.binding.filesystem.mountId !== approved.runtimeFilesystem.mountId) throw new WorkerError('job_runtime_root_mismatch');
    const configuration = InstalledJobRuntimeConfigurationRecordSchema.parse(await captureInstalledRuntimeConfigurationRecord(input));
    const bytes = Buffer.from(`${JSON.stringify(configuration)}\n`);
    if (bytes.length > (configuration.schemaVersion === 2 ? 2 * 1024 * 1024 + 65536 : 65536)) throw new WorkerError('job_runtime_configuration_too_large');
    const temporary = anchored(state, `.job-runtime-${randomUUID()}`);
    const staged = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await staged.chmod(0o600); await staged.writeFile(bytes); await staged.sync(); } finally { await staged.close(); }
      if (operation === 'refresh') {
        await preserveConfiguration(state, basename(previousConfigurationPath), previousBytes);
        await rename(temporary, output);
      } else {
        try { await link(temporary, output); }
        catch (error) { if (error.code === 'EEXIST') throw new WorkerError('job_runtime_configuration_exists', undefined, { cause: error }); throw error; }
      }
      await state.sync();
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    await state.sync();
    return { configurationPath: join(stateDirectory, 'job-runtime.json'), captured: true, qualified: false, executionAuthorized: false,
      ...(previousConfigurationPath ? { refreshed: true, previousConfigurationPath } : {}) };
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('job_runtime_capture_failed', undefined, { cause: error });
  } finally { try { await unlock?.(); } finally { await state.close(); } }
}
