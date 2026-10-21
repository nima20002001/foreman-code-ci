import { RemoteOperationJournal } from '../../../apps/api/src/modules/runs/remote/operationJournal.ts';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInstalledBrowserComposition } from '../../../apps/api/src/modules/collaboration/workerBrowser.ts';
import { createWorkerBrowserRuntime } from './browserRuntime.mjs';
import { createWorkerBrowserDeviceExtension } from './browserDeviceExtension.mjs';
import { createInstalledWorkerDomains } from '../../../apps/api/src/modules/devices/installedWorkerDomains.ts';
import { codexQualificationSuite } from '../../../apps/api/src/modules/harnesses/qualification/suites/codex.ts';
import { qualificationRevisionWithIdentity } from '../../../apps/api/src/modules/harnesses/qualification/identity.ts';
import { loadApprovedRoots } from './approvedRoots.mjs';
import { createWorkerExecutionDomains } from '../../../apps/api/src/modules/runs/remote/workerComposition.ts';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { loadOrCreateWorkerIdentity, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { createWorkerConnection } from '../../../apps/api/src/modules/devices/workerConnection.ts';
import { hostFacts, requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { validateManifest, requireReleaseState } from './installation.mjs';
import { startWorker, acquireWorkerLock } from './runtime.mjs';
import { approvedRootExtensions } from './rootExtension.mjs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { workerUpdateExtension } from './update.mjs';
import { createInstalledWorkerUpdater } from './installedUpdater.mjs';
import { loadWorkerRsyncEntrypoint } from '../../../apps/api/src/modules/byte-transfer/installedEntrypoints.ts';
import { ensurePairedManagedSetup } from './managedSetup.mjs';
import { refreshWorkflowSelection } from './workflowSelection.mjs';
import { registerWorkerMcpInstallation } from '../../../apps/api/src/modules/harnesses/workerMcpInstallation.ts';

import { readUpdateRecord } from './updateSupervisor.mjs';
import { WORKER_UPDATE_NAMESPACE } from '../../../packages/contracts/src/workerUpdate.ts';
import { runWorkerStartupSmoke, workerCiStartupStatus, runCiInstallSmoke } from './ciInstallSmoke.mjs';
import { HostCiRunner } from '../../../apps/api/src/modules/ci-host/runner.ts';
import { isDeepStrictEqual } from 'node:util';
import { WorkerArtifactReplySchema, WorkerArtifactManifestSchema } from '../../../packages/contracts/src/workerUpdate.ts';
import { workerArtifactContentSha256 } from '../../../packages/contracts/src/workerArtifactContentNode.mjs';
import { workerBundleReadiness, requireWorkerBundleReady } from '../../../apps/api/src/modules/computers/workerBundleReadiness.ts';

export function runInstalledCiSmoke(input, { signal } = {}) {
  return runCiInstallSmoke(input, { runner: new HostCiRunner(), signal });
}
export { ensurePairedManagedSetup };
export { refreshWorkflowSelection };
export { inspectManagedInstallation } from './managedInstallation.mjs';

export { createWorkerConnection };
export { approvedRootExtensions, createWorkerExecutionDomains };
// Arbitrary paths use explicit local approval; managed storage is qualified during pairing.
export { qualifyApprovedRootAllowlist } from '../../../apps/api/src/modules/sources/rootAttestation.ts';
export { captureInstalledRuntimeConfiguration, captureInstalledRuntimeConfigurationRecord } from '../../../apps/api/src/modules/jobs/installedRuntimeHost.ts';

export async function prepareWorkerState(stateDirectory) {
  const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
  if (!facts.rootPersistent || !facts.homePersistent || !facts.storagePersistent) throw new WorkerError('nonpersistent_storage');
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  validateManifest(manifest, facts, { protocolVersion: 1, identityFormat: 1 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(stateDirectory);
  await requireReleaseState({ directory: fileURLToPath(new URL('../', import.meta.url)), stateDirectory });
  return manifest;
}

// Explicit installer action: never recreate a missing established journal on boot.
export async function initializeInstalledNativeRuntime(stateDirectory) {
  await prepareWorkerState(stateDirectory);
  const unlock = await acquireWorkerLock(stateDirectory);
  try {
    const journals = ['workflow-operations.json', 'job-runtime-operations.json'];
    for (const name of journals) {
      const existing = await lstat(join(stateDirectory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (existing) throw new WorkerError('native_runtime_already_initialized');
    }
    for (const name of ['workflow-native-processes', 'job-runtime-native-processes']) {
      const originalRegistry = await lstat(join(stateDirectory, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (originalRegistry) throw new WorkerError('native_runtime_recovery_required');
    }
    for (const name of journals) {
      const journal = await RemoteOperationJournal.open(join(stateDirectory, name), { initializeNewInstallation: true });
      await journal.close();
    }
  } finally { await unlock(); }
}

// Only supplied, actual domain registrations enter the authenticated transport.
// The package never manufactures dispatch handlers or another workflow authority.
export async function startConfiguredWorker({ stateDirectory, extensions = [], executionDomains, rsync }) {
  const manifest = await prepareWorkerState(stateDirectory);
  stateDirectory = await realpath(stateDirectory);
  const execution = executionDomains ? createWorkerExecutionDomains(executionDomains) : undefined;
  let installed, connection, rsyncEntrypoint, updater, managedSetup, manifestSha256, browser, browserStarting;
  const startupCi = { pending: false, error: null };
  const startupLifetime = new AbortController();
  let startupTask;
  const pairingReads = new Set();
  const readPairing = async () => {
    const task = loadWorkerPairing(stateDirectory);
    pairingReads.add(task);
    try { return await task; }
    finally { pairingReads.delete(task); }
  };
  const bindingDrains = new Set();
  const bindingFailures = [];
  const bindingLost = binding => {
    let task;
    try { task = Promise.allSettled([installed?.rsyncWriters?.bindingLost(binding), browser?.bindingLost(binding)]).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Worker binding loss remains incomplete.');
    }); }
    catch (error) { task = Promise.reject(error); }
    bindingDrains.add(task);
    void task.then(() => bindingDrains.delete(task), error => { bindingDrains.delete(task); bindingFailures.push(error); });
  };
  const runtime = await startWorker({ stateDirectory, appVersion: manifest.version,
    loadIdentity: loadOrCreateWorkerIdentity, beforeUnlock: async () => {
    startupLifetime.abort(new Error('Worker stopped during CI smoke.'));
    browser?.stopAdmission();
    await browserStarting;
    const updaterClosing = updater?.close();
    // Connection cancellation ends its deadline wait, but pairing reads can still write identity state.
    const results = await Promise.allSettled([execution?.close(), installed?.close(),
      installed?.rsyncWriters?.close(), updaterClosing, startupTask, browser?.close(), ...pairingReads]);
    while (bindingDrains.size) await Promise.allSettled([...bindingDrains]);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []).concat(bindingFailures);
    if (failures.length) throw new AggregateError(failures, 'Worker shutdown remains incomplete.');
    if (rsyncEntrypoint?.kind === 'configured') await rsyncEntrypoint.close();
  }, createConnection: async ({ bootId, assertStateOwnership }) => {
    assertStateOwnership();
    await registerWorkerMcpInstallation({ home: process.env.HOME ?? '', stateDirectory,
      releaseDirectory: fileURLToPath(new URL('../', import.meta.url)) });
    const pairing = await loadWorkerPairing(stateDirectory);
    managedSetup = executionDomains ? undefined
      : await ensurePairedManagedSetup({ stateDirectory, pairing, assertStateOwnership });
    if (managedSetup?.state === 'failed') process.stderr.write(`Managed CI setup: ${managedSetup.message}\n`);
    if (!executionDomains) {
      const facts = await hostFacts(process.env.HOME ?? '', [stateDirectory]);
      const releaseDirectory = fileURLToPath(new URL('../', import.meta.url));
      manifestSha256 = createHash('sha256').update(await readFile(join(releaseDirectory, 'manifest.json'))).digest('hex');
      browser = createInstalledBrowserComposition({ stateDirectory, root: dirname(dirname(releaseDirectory.replace(/\/$/, ''))), facts,
        installationId: pairing.workerInstallationId, computerId: pairing.deviceId, connection: () => connection,
        readPairing: () => loadWorkerPairing(stateDirectory), assertHostOwnership: async () => assertStateOwnership(),
        createRuntime: createWorkerBrowserRuntime, createExtension: createWorkerBrowserDeviceExtension,
        reportFailure: error => process.stderr.write(`Browser runtime: ${error.code ?? 'browser_runtime_failed'}\n`) });
      const update = await readUpdateRecord(stateDirectory);
      startupCi.pending = update?.status.state === 'restarting' && update.manifestSha256 === manifestSha256
        && !update.restart?.ciSmoke;
      updater = await createInstalledWorkerUpdater({ browser, domains: () => installed, stateDirectory, version: manifest.version, manifestSha256,
        workerInstallationId: pairing.workerInstallationId, releaseDirectory, facts, assertStateOwnership,
        connection: () => connection,
        reportError: error => process.stderr.write(`Worker update: ${error.message ?? error.code ?? 'worker_update_failed'}\n`),
        log: (msg, fields) => process.stdout.write(`${JSON.stringify({ level: 'info', time: new Date().toISOString(),
          component: 'worker-update', ...fields, msg })}\n`),
      });
    }
    const rootExtensions = managedSetup?.state === 'failed' ? []
      : await approvedRootExtensions(stateDirectory, pairing, bootId);
    if (!executionDomains) {
      if (!rsync) {
        try { rsyncEntrypoint = await loadWorkerRsyncEntrypoint({ path: join(stateDirectory, 'rsync-selection.json'), pairing,
          entryPoint: fileURLToPath(new URL('./rsync-writer.mjs', import.meta.url)),
          current: () => connection?.currentBinding(), ownership: () => installed?.rsyncOwnership,
          request: async (payload, signal) => {
            const captured = connection?.captureRequest('rsync-stage-v1');
            if (!captured) throw new WorkerError('rsync_authorization_unavailable');
            return captured.request(payload, { signal });
          } }); } catch (error) {
          process.stderr.write(`rsync unavailable: ${error.message}\n`);
          throw error;
        }
        if (rsyncEntrypoint.kind === 'unavailable') process.stderr.write(`rsync unavailable: ${rsyncEntrypoint.reason}\n`);
      }
      const refreshWorkflowConfiguration = signal => refreshWorkflowSelection({ stateDirectory,
        assertStateOwnership, ...(signal ? { signal } : {}) });
      const selection = managedSetup?.state === 'failed' ? null : await refreshWorkflowConfiguration();
      const jobConfigurationPath = join(stateDirectory, 'job-runtime.json');
      const jobSelection = await lstat(jobConfigurationPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      installed = await createInstalledWorkerDomains({ stateDirectory, pairing, bootId, assertStateOwnership,
        assertBundleReady: async context => {
          const captured = connection?.captureRequest(WORKER_UPDATE_NAMESPACE);
          if (!captured || !isDeepStrictEqual(captured.binding, context.binding)) {
            throw new WorkerError('worker_update_channel_unavailable');
          }
          const status = await updater.status();
          let response;
          try {
            response = await captured.request({ operation: 'release', target: status.target }, { signal: context.signal });
          } catch (error) {
            if (error.code !== 'WORKER_RELEASE_ASSET_UNAVAILABLE') throw error;
            requireWorkerBundleReady(workerBundleReadiness(null, status, 'Worker release assets have not been published.'));
          }
          const reply = WorkerArtifactReplySchema.parse(response.payload);
          const release = reply.operation === 'release' ? reply.release : null;
          let expectedBundle = null;
          if (release) {
            const published = WorkerArtifactManifestSchema.parse(release.manifest);
            expectedBundle = { version: published.version, target: published.target,
              manifestSha256: release.manifestSha256, contentSha256: workerArtifactContentSha256(published) };
          }
          const running = await updater.status();
          context.signal.throwIfAborted();
          requireWorkerBundleReady(workerBundleReadiness(expectedBundle, running));
        },
        launcherSource: new URL('../artifacts/graphql-mcp.mjs', import.meta.url),
        ciStartupPending: async () => startupCi.pending || (await updater?.status())?.state === 'restarting',
        ...(updater ? { workerUpdate: { status: () => updater.status(), start: options => updater.start(options),
          outcome: (task, deadlineAt) => updater.maintenanceOutcome(task, deadlineAt) } } : {}),
        browserRuntime: { status: () => browser.status(), retry: () => browser.retry() },
        configuration: selection,
        ...(managedSetup?.state !== 'failed' ? { refreshWorkflowConfiguration } : {}),
        jobConfiguration: jobSelection && managedSetup?.state !== 'failed'
          ? { path: jobConfigurationPath, ownerUid: process.getuid() } : null,
        approvedRoots: () => managedSetup?.state === 'failed' ? Promise.resolve(null)
          : loadApprovedRoots(stateDirectory, pairing), connection: () => connection,
        ...(rsync ? { rsync } : rsyncEntrypoint?.kind === 'configured' ? { rsync: rsyncEntrypoint.providers } : {}),
        codexSuiteRevision: qualificationRevisionWithIdentity(codexQualificationSuite.revision) });
      if (installed.rsync) {
        for (const intent of installed.rsyncOwnership.inventory()) {
          if (Date.parse(intent.expiresAt) <= Date.now()) await installed.rsync.retireExpired(intent);
        }
      }
      if (!installed.rsyncAvailable && rsyncEntrypoint?.kind === 'configured') {
        process.stderr.write(`rsync unavailable: ${installed.rsyncMissing.join(', ')}\n`);
        throw new WorkerError('rsync_runtime_unavailable');
      }
    }
    connection = createWorkerConnection({ pairing, bootId, appVersion: manifest.version,
      readPairing,
      onBindingLost: bindingLost,
      onReady: () => {
        browserStarting = browser?.start().catch(error => {
          process.stderr.write(`Browser startup: ${error.code ?? 'browser_startup_failed'}\n`);
        });
        if (!startupCi.pending) { updater?.ready(); return; }
        startupTask ??= runWorkerStartupSmoke({ manifestSha256,
          request: payload => {
            const captured = connection.captureRequest(WORKER_UPDATE_NAMESPACE);
            if (!captured) throw new WorkerError('worker_update_channel_unavailable');
            return captured.request(payload, { timeoutMs: 5000, signal: startupLifetime.signal });
          },
          smoke: input => runCiInstallSmoke(input, { runner: new HostCiRunner(), signal: startupLifetime.signal }),
        }).then(() => { startupCi.pending = false; updater?.ready(); }, error => {
          startupCi.error = error.message;
          process.stderr.write(`Worker startup CI smoke failed: ${error.message}\n`);
        });
      },
      extensions: [...extensions, ...(browser ? [browser.registration] : []), ...(updater ? [workerUpdateExtension] : []),
        ...(execution?.extensions ?? []), ...(installed?.extensions ?? []), ...rootExtensions] });
    return {
      start: () => connection.start(),
      stop: () => connection.stop(),
      status: () => workerCiStartupStatus(connection.status(), startupCi),
    };
  } });
  return { ...runtime, managedSetup, updating: () => Boolean(updater?.active) };
}
