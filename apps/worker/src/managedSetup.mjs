import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realpath, unlink } from 'node:fs/promises';
import { CiManagedSetupSchema } from '../../../packages/contracts/src/ciEnrollment.ts';
import { loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { ApprovedRootAllowlistSchema } from '../../../packages/contracts/src/workspaceRootPolicies.ts';
import { qualifyApprovedRootAllowlist } from '../../../apps/api/src/modules/sources/rootAttestation.ts';
import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { openPrivateRoot, openChildDirectory, anchored } from '../../../apps/api/src/modules/sources/privateFilesystem.ts';
import { CiRuntimeInstallationSchema } from '../../../apps/api/src/modules/jobs/ciRuntimeInstallation.ts';
import { MAX_VERIFICATION_CONFIGURATION_BYTES } from '../../../apps/api/src/modules/jobs/installedVerificationConfiguration.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { createManagedStorage, optionalManagedJson, managedEntryExists, publishManagedJson } from './managedState.mjs';
import { discoverManagedInstallation, inspectManagedInstallation, retireManagedInstallation,
  pairingTarget, samePairingTarget } from './managedInstallation.mjs';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { DomainError } from '../../../apps/api/src/modules/errors.ts';
import { assertRuntimeQuiescent } from './jobRuntimeCapture.mjs';

const runtimeUnavailable = 'Pairing approved the private managed roots. This computer has no installed quota-enabled CI runtime to adopt.';

async function initializeManagedJournals(state, stateDirectory, established, assertStateOwnership) {
  for (const [journalName, registryName] of [['workflow-operations.json', 'workflow-native-processes'],
    ['job-runtime-operations.json', 'job-runtime-native-processes']]) {
    const exists = await managedEntryExists(state, journalName);
    if (!exists && (established || await managedEntryExists(state, registryName)
      || await managedEntryExists(state, `${journalName}.owner-guard`))) {
      throw new WorkerError('managed_runtime_recovery_required');
    }
    const journal = await RemoteOperationJournal.open(join(stateDirectory, journalName), {
      initializeNewInstallation: !exists, assertExclusiveOwner: assertStateOwnership,
    });
    await journal.close();
  }
}

async function approveManagedRoots(state, stateDirectory, pairing, runtimeRoot) {
  const current = await optionalManagedJson(state, 'approved-roots.json');
  if (current) {
    const approved = ApprovedRootAllowlistSchema.parse(current);
    const belongsToPairing = approved.hostRef.kind === 'device' && approved.hostRef.mainId === pairing.mainId
      && approved.hostRef.deviceId === pairing.deviceId && approved.applicationInstallationId === pairing.workerInstallationId;
    if (!belongsToPairing) {
      await assertRuntimeQuiescent(stateDirectory);
      const archive = await openChildDirectory(state, 'retired-runtime', true);
      try { await publishManagedJson(archive, `roots-${randomUUID()}.json`, approved); }
      finally { await archive.close(); }
      const managed = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
        hostRef: pairingTarget(pairing).hostRef, applicationInstallationId: pairing.workerInstallationId,
        configurationRevision: String(BigInt(approved.configurationRevision) + 1n),
        bases: [{ baseId: randomUUID(), canonicalPath: join(stateDirectory, 'managed/workspaces'),
          accessModes: ['read-write'], managedBy: 'worker-pairing' }], managedRuntimeRoot: runtimeRoot });
      await publishManagedJson(state, 'approved-roots.json', managed);
      return managed;
    }
    const verified = await loadApprovedRoots(stateDirectory, pairing);
    if (!approved.runtimeFilesystemId || approved.bases.some(base => !base.filesystemId)) {
      await publishManagedJson(state, 'approved-roots.json', verified);
    }
    if (verified.bases.some(base => base.managedBy === 'worker-pairing')) return verified;
    const managed = await qualifyApprovedRootAllowlist({ ...verified,
      configurationRevision: String(BigInt(approved.configurationRevision) + 1n),
      bases: [...verified.bases, { baseId: randomUUID(), canonicalPath: join(stateDirectory, 'managed/workspaces'),
        accessModes: ['read-write'], managedBy: 'worker-pairing' }],
    });
    await publishManagedJson(state, 'approved-roots.json', managed);
    return managed;
  }
  const configuration = await qualifyApprovedRootAllowlist({ schemaVersion: 1,
    hostRef: pairingTarget(pairing).hostRef, applicationInstallationId: pairing.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: join(stateDirectory, 'managed/workspaces'),
      accessModes: ['read-write'], managedBy: 'worker-pairing' }], managedRuntimeRoot: runtimeRoot });
  await publishManagedJson(state, 'approved-roots.json', configuration);
  return configuration;
}

async function setupManagedStorage(options, state, previous) {
  const { stateDirectory, pairing, home, assertStateOwnership } = options;
  const actual = await loadWorkerPairing(stateDirectory);
  if (!samePairingTarget(actual, pairing) || Date.parse(actual.expiresAt) <= Date.now()) {
    throw new WorkerError('managed_setup_pairing_changed');
  }
  if (await managedEntryExists(state, 'managed-retirement.json')) throw new WorkerError('managed_installation_retired');
  const facts = await hostFacts(home, [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  assertStateOwnership();
  await createManagedStorage(state);
  await initializeManagedJournals(state, stateDirectory, previous?.journalsInitialized === true, assertStateOwnership);
  previous.journalsInitialized = true;
  const record = { schemaVersion: 1, target: pairingTarget(pairing), journalsInitialized: true,
    status: CiManagedSetupSchema.parse({ state: 'runtime-unavailable', migrated: previous?.status?.migrated ?? false,
      message: runtimeUnavailable, updatedAt: new Date().toISOString() }) };
  await publishManagedJson(state, 'managed-setup.json', record);

  let installation = await optionalManagedJson(state, 'managed-adoption.json', MAX_VERIFICATION_CONFIGURATION_BYTES + 16384);
  const currentRuntime = await optionalManagedJson(state, 'job-runtime.json', MAX_VERIFICATION_CONFIGURATION_BYTES);
  const currentTarget = currentRuntime?.descriptor?.target ?? currentRuntime?.target;
  const hasCurrentRuntime = JSON.stringify(currentTarget) === JSON.stringify(pairingTarget(pairing));
  if (!installation && !hasCurrentRuntime
    && (currentRuntime || !await managedEntryExists(state, 'ci-runtime-installation.json'))) {
    installation = await discoverManagedInstallation(home, stateDirectory, pairing);
    if (installation) {
      await publishManagedJson(state, 'managed-adoption.json', installation);
    }
  }
  if (installation) {
    await retireManagedInstallation(installation, pairingTarget(pairing), state,
      { assertStateOwnership, home, inspectInstallation: options.inspectInstallation ?? inspectManagedInstallation });
    record.status.migrated = true;
  }
  let bootstrap = await optionalManagedJson(state, 'ci-runtime-installation.json', MAX_VERIFICATION_CONFIGURATION_BYTES + 4096);
  if (bootstrap && JSON.stringify(CiRuntimeInstallationSchema.parse(bootstrap).target) !== JSON.stringify(pairingTarget(pairing))) {
    if (currentRuntime) throw new WorkerError('managed_setup_pairing_changed');
    await assertRuntimeQuiescent(stateDirectory, assertStateOwnership);
    bootstrap = { ...bootstrap, target: pairingTarget(pairing) };
    await publishManagedJson(state, 'ci-runtime-installation.json', bootstrap);
    record.status.migrated = true;
  }
  if (currentRuntime && !hasCurrentRuntime && !installation) throw new WorkerError('managed_installation_runtime_unsupported');
  const runtimeRoot = bootstrap?.runtime.descriptor.runtimeRoot ?? join(stateDirectory, 'managed/runtime');
  await approveManagedRoots(state, stateDirectory, pairing, runtimeRoot);
  if (bootstrap || await managedEntryExists(state, 'job-runtime.json')) {
    record.status.state = 'ready';
    record.status.message = null;
  }
  record.status.updatedAt = new Date().toISOString();
  await publishManagedJson(state, 'managed-setup.json', record);
  if (installation) {
    await unlink(anchored(state, 'managed-adoption.json'));
    await state.sync();
  }
  return record.status;
}

/** Pairing is the human approval for fixed private product storage. Startup resumes an interrupted setup. */
export async function ensurePairedManagedSetup({ stateDirectory, pairing, home = process.env.HOME ?? '',
  assertStateOwnership, inspectInstallation }) {
  await requirePrivateDirectory(stateDirectory);
  stateDirectory = await realpath(stateDirectory);
  home = await realpath(home);
  let unlock;
  if (!assertStateOwnership) {
    unlock = await acquireWorkerLock(stateDirectory);
    assertStateOwnership = unlock.assertOwned;
  }
  let state;
  let previous;
  try {
    state = await openPrivateRoot(stateDirectory);
    previous = await optionalManagedJson(state, 'managed-setup.json') ?? {};
    return await setupManagedStorage({ stateDirectory, pairing, home, assertStateOwnership, inspectInstallation }, state, previous);
  } catch (error) {
    if (!state) throw error;
    const status = CiManagedSetupSchema.parse({ state: 'failed', migrated: previous?.status?.migrated ?? false,
      message: managedSetupFailure(error), updatedAt: new Date().toISOString() });
    await publishManagedJson(state, 'managed-setup.json', { schemaVersion: 1, target: pairingTarget(pairing),
      journalsInitialized: previous?.journalsInitialized === true, status });
    return status;
  } finally {
    try {
      await state?.close();
    } finally {
      await unlock?.();
    }
  }
}

function managedSetupFailure(error) {
  if (error?.code === 'worker_already_running') return 'The previous Worker is still running; managed CI adoption will retry on startup.';
  if (error?.code === 'managed_runtime_recovery_required') return 'An established native journal is missing; original runtime recovery is required.';
  if (error?.message === 'Installed runtime still has unfinished work.') {
    return 'The previous installation still has unfinished work; automatic adoption will retry after it finishes.';
  }
  let code = 'managed_setup_failed';
  if (error instanceof WorkerError || error instanceof DomainError) code = error.code;
  else if (error?.name === 'ZodError') code = 'managed_installation_configuration_invalid';
  return `Automatic managed CI setup failed (${code}). The Worker will retry on startup.`;
}
