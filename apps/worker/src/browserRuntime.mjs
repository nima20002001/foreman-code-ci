import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInstalledRelease } from './installation.mjs';
import { readInstalledBrowserRuntime, readBrowserRuntimeStatus, writeBrowserRuntimeStatus,
  stageBundledBrowserRuntime, offlineBrowserRuntimeLifecycle, activateBrowserRuntime } from './browserRuntimeInstall.mjs';

const digest = /^[a-f0-9]{64}$/;
const importHost = path => import(pathToFileURL(path).href);

function unavailable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'BROWSER_RUNTIME_UNAVAILABLE';
  return error;
}

function approveRuntime(release, runtime) {
  const approved = release?.manifest?.browserRuntime?.manifestSha256;
  if (!digest.test(approved ?? '') || approved !== runtime.manifestSha256) {
    throw unavailable('The managed browser runtime does not match the selected Worker release.');
  }
}

function requireNativeModule(module) {
  if (typeof module?.createBrowserHost !== 'function'
    || typeof module?.restoreBrowserRuntimeProfiles !== 'function') {
    throw unavailable('The managed browser runtime is missing its native host entrypoints.');
  }
  return module;
}

/**
 * Explicit Worker bootstrap and update lifecycle. Construction and status reads
 * perform no I/O. The existing Worker owner supplies its authority/pairing ports;
 * only a fully verified unit belonging to the selected release is imported.
 * readSelectedRelease/readInstalled/loadModule are private injectable test ports.
 */
export function createWorkerBrowserRuntime(options) {
  const { root, stateDirectory, computerId, installationId, facts, expected,
    subjectAuthority, pairing, keys, assertHostOwnership, reportFailure, originProbe,
    readSelectedRelease = readInstalledRelease, readInstalled = readInstalledBrowserRuntime,
    loadModule = importHost, runtimeRoot = join(root, 'browser-runtime') } = options;
  let host = null, nativeModule = null, installed = null;
  let offlineLifecycle = null;
  let phase = 'unavailable', admissionStopped = false, closed = false, lastFailure = null;
  let tail = Promise.resolve();
  const profileStateRoot = join(stateDirectory, 'browser', 'profile-data');

  function serialize(work) {
    const task = tail.then(work, work);
    tail = task.catch(() => { /* ignore: the returned operation reports the failure; retain a usable serialization tail. */ });
    return task;
  }

  function status() {
    const native = host?.status();
    const ready = Boolean(host && phase === 'ready' && !admissionStopped
      && native?.ready !== false && native?.admissionPaused !== true);
    return { computerId, ready, phase, ...(installed ? { runtimeVersion: installed.runtimeVersion,
      profileFormat: installed.profileFormat, manifestSha256: installed.manifestSha256 } : {}),
      ...(!ready ? { reason: host ? 'resource_pressure' : 'runtime_missing', retryable: !closed,
        message: lastFailure ?? (phase === 'draining' ? 'Browser admission is paused for an update.'
          : 'The managed browser runtime is not ready. Repair or update this computer.') } : {}) };
  }

  async function startHost() {
    if (closed) throw unavailable('This browser runtime owner has been closed.');
    if (host) return status();
    phase = 'starting'; lastFailure = null;
    let release;
    try {
      await assertHostOwnership();
      release = await readSelectedRelease({ root, facts, expected });
      const descriptor = await readInstalled({ runtimeRoot, target: facts });
      approveRuntime(release, descriptor);
      const module = requireNativeModule(await loadModule(descriptor.nativeHostModule));
      // A delayed import must not admit a host for a release that lost selection.
      approveRuntime(await readSelectedRelease({ root, facts, expected }), descriptor);
      await assertHostOwnership();
      const next = await module.createBrowserHost({ stateDirectory, computerId, installationId,
        runtime: descriptor, subjectAuthority, pairing, keys, assertHostOwnership, reportFailure, originProbe });
      host = next; nativeModule = module; installed = descriptor;
      if (admissionStopped) host.stopAdmission();
      phase = admissionStopped ? 'draining' : 'ready';
      return status();
    } catch (error) {
      phase = 'unavailable'; lastFailure = 'The managed browser runtime is missing, incompatible, or not ready. Repair or update this computer.';
      reportFailure(error);
      const retained = release && await readBrowserRuntimeStatus(root);
      if (retained?.state === 'failed' && retained.manifestSha256 === release.manifestSha256) {
        phase = 'failed'; lastFailure = retained.reason;
      }
      return status();
    }
  }

  async function retryInstallation() {
    if (closed) throw unavailable('This browser runtime owner has been closed.');
    if (host) return status();
    await assertHostOwnership();
    const release = await readSelectedRelease({ root, facts, expected });
    phase = 'installing'; lastFailure = null;
    try {
      const staged = await stageBundledBrowserRuntime({ root, artifact: release.directory, manifest: release.manifest,
        target: facts, readiness: options.browserRuntimeReadiness });
      if (!staged) throw unavailable('This release needs a verified browser artifact from a matching target runner.');
      const selected = await readSelectedRelease({ root, facts, expected });
      if (selected.manifestSha256 !== release.manifestSha256 || closed) {
        throw unavailable('The Worker release changed while repairing its browser runtime.');
      }
      await assertHostOwnership();
      const lifecycle = await offlineBrowserRuntimeLifecycle({ nativeHostModule: staged.nativeHostModule, profileStateRoot });
      await activateBrowserRuntime({ runtimeRoot, staged, drain: lifecycle.drain });
      await writeBrowserRuntimeStatus(root, { state: 'ready', retryable: false,
        manifestSha256: release.manifestSha256, reason: null });
      return await startHost();
    } catch (error) {
      phase = 'failed'; lastFailure = error.message;
      reportFailure(error);
      await writeBrowserRuntimeStatus(root, { state: 'failed', retryable: true,
        manifestSha256: release.manifestSha256, reason: lastFailure });
      return status();
    }
  }

  function stopAdmission() {
    admissionStopped = true;
    host?.stopAdmission();
    if (host) phase = 'draining';
  }

  async function stopHost() {
    await assertHostOwnership();
    if (host) {
      // Keep the owner on failure so a retry can settle pending native cleanup.
      await host.close();
      host = null;
    }
    phase = 'stopped';
  }

  return {
    start: () => serialize(startHost),
    retry: () => serialize(retryInstallation),
    status,
    getHost: () => host,
    getModule: () => nativeModule,
    stopAdmission,
    resumeAdmission: () => serialize(async () => {
      if (!host || closed) throw unavailable('No active browser runtime can resume admission.');
      await assertHostOwnership();
      host.resumeAdmission(); admissionStopped = false; phase = 'ready';
      return status();
    }),
    drain: input => serialize(async () => {
      await assertHostOwnership();
      if (!host) {
        if (closed || !input?.next) throw unavailable('No verified browser runtime can checkpoint its profile data.');
        stopAdmission();
        // Activation verifies the staged unit before handing it to this callback.
        offlineLifecycle = await offlineBrowserRuntimeLifecycle({
          nativeHostModule: input.next.nativeHostModule, profileStateRoot,
        });
        const checkpoint = await offlineLifecycle.drain();
        await assertHostOwnership();
        return checkpoint;
      }
      const wasStopped = admissionStopped;
      stopAdmission();
      try { return await host.drainForRuntimeUpdate(); }
      catch (error) {
        if (!wasStopped) { host.resumeAdmission(); admissionStopped = false; phase = 'ready'; }
        throw error;
      }
    }),
    stop: () => { stopAdmission(); return serialize(stopHost); },
    restoreProfiles: checkpointId => serialize(async () => {
      await assertHostOwnership();
      if (host) throw unavailable('Stop the new browser host before restoring its compatible profile checkpoint.');
      if (offlineLifecycle) return offlineLifecycle.restoreProfiles(checkpointId);
      if (!nativeModule) throw unavailable('No verified browser host is available to restore its profile checkpoint.');
      return nativeModule.restoreBrowserRuntimeProfiles({ profileStateRoot, checkpointId });
    }),
    close: () => { closed = true; stopAdmission(); return serialize(stopHost); },
  };
}
