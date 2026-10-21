import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { WorkerArtifactManifestSchema, WorkerArtifactReplySchema, WorkerUpdateStatusSchema,
  WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION, WORKER_UPDATE_MAX_BINARY_BYTES,
  WORKER_UPDATE_MAX_JSON_BYTES, WORKER_UPDATE_ATTEMPT_TIMEOUT_MS } from '../../../packages/contracts/src/workerUpdate.ts';
import { readWorkerSmokeConfiguration } from './ciInstallSmoke.mjs';
import { waitForUpdateOperation } from './updateOperation.mjs';
import { workerArtifactContentSha256 } from '../../../packages/contracts/src/workerArtifactContentNode.mjs';
import { WorkerError, workerUpdateErrorMessage } from './diagnostics.mjs';
import { validateManifest, stageRunningVersion, migrateReleaseCompanionLauncher } from './installation.mjs';
import { readUpdateRecord, writeUpdateRecord, locateWorkerLaunch, launchUpdateSupervisor,
  recoverPendingWorkerUpdate, workerPointerMatches } from './updateSupervisor.mjs';
import { DeviceConnectionError } from '../../../apps/api/src/modules/devices/deviceWire.ts';
import { DeviceApplicationError } from '../../../apps/api/src/modules/devices/deviceApplicationError.ts';
import { extractWorkerArchive, fetchGitHubAsset, workerArchiveLimits, requireArchiveCapacity }
  from './workerArtifactArchive.mjs';

export { fetchGitHubAsset };

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = { protocolVersion: 1, identityFormat: 1 };
const automaticRetryErrors = new Set(['worker_update_interrupted', 'worker_updater_stopped',
  'worker_update_channel_unavailable', 'worker_update_download_timeout', 'WORKER_RELEASE_ASSET_UNAVAILABLE',
  'worker_update_smoke_unavailable', 'worker_update_deadline_exceeded', 'worker_update_drain_deadline_exceeded']);

export const workerUpdateExtension = { namespace: WORKER_UPDATE_NAMESPACE, version: WORKER_UPDATE_VERSION,
  role: 'client', maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES, maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES };

/** The release asset is only a carrier: every installed byte is still checked against the announced manifest. */
async function downloadFromGitHub({ release, announced, directory, signal, fetchAsset }) {
  const scratch = await mkdtemp(join(dirname(directory), '.worker-github-'));
  try {
    const archive = join(scratch, 'artifact.tar.gz');
    const limits = workerArchiveLimits(announced);
    await requireArchiveCapacity(scratch, limits);
    await fetchAsset({ github: release.github, asset: `${release.manifestSha256}.tar.gz`, destination: archive,
      signal, maxBytes: limits.compressedBytes });
    return await extractWorkerArchive({ archive, announced, release, directory, limits, signal });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function downloadWorkerArtifact({ signal, timeoutMs = 600_000, ...options }) {
  const deadline = new AbortController();
  const combined = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
  const timer = setTimeout(() => deadline.abort(new WorkerError('WORKER_RELEASE_ASSET_UNAVAILABLE',
    `GitHub Worker bundle download timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await downloadArtifactFiles({ ...options, signal: combined });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WorkerError && error.code === 'WORKER_RELEASE_ASSET_UNAVAILABLE') throw error;
    combined.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

async function downloadArtifactFiles({ release, directory, facts, signal,
  fetchAsset = fetchGitHubAsset, onDownloadComplete, log = () => {} }) {
  const announced = WorkerArtifactManifestSchema.parse(release.manifest);
  validateManifest(announced, facts, expected);
  if (announced.version !== release.version) throw new WorkerError('manifest_version_mismatch');
  if (!release.github) throw new WorkerError('WORKER_RELEASE_ASSET_UNAVAILABLE',
    'Main has no verified GitHub release asset for this Worker version.');
  const backoff = [5000, 10000, 20000, 40000, 60000];
  let lastGitHubError;
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      log('Worker bundle download from GitHub started', { source: 'github', attempt: attempt + 1 });
      try {
        const manifest = await downloadFromGitHub({ release, announced, directory, signal, fetchAsset });
        signal.throwIfAborted();
        await onDownloadComplete?.({ source: 'github' });
        return manifest;
      } catch (error) {
        if (signal.aborted) throw error;
        if (!(error instanceof WorkerError) || error.code !== 'worker_update_github_unavailable') throw error;
        lastGitHubError = workerUpdateErrorMessage(error);
        const retryMs = backoff[Math.min(attempt, backoff.length - 1)];
        log('GitHub Worker asset unavailable; retrying GitHub', { source: 'github', error: lastGitHubError, retryMs });
        await delay(retryMs, signal);
      }
    }
  } catch (error) {
    if (signal.aborted && signal.reason?.code === 'WORKER_RELEASE_ASSET_UNAVAILABLE') {
      const reason = [signal.reason.message, lastGitHubError].filter(Boolean).join(' Last GitHub error: ');
      throw new WorkerError('WORKER_RELEASE_ASSET_UNAVAILABLE', reason, { cause: error });
    }
    throw error;
  }
}

export class WorkerUpdater {
  constructor(options) {
    this.options = options;
    this.active = undefined;
    this.timer = undefined;
    this.closed = false;
    this.lifetime = new AbortController();
    this.recordOperation = Promise.resolve();
    this.operations = new Set();
    this.statusValue = { currentVersion: options.version, manifestSha256: options.manifestSha256,
      targetVersion: null, state: 'current', lastError: null };
  }

  async initialize() {
    if (this.options.releaseDirectory) {
      const bytes = await readFile(join(this.options.releaseDirectory, 'manifest.json'));
      if (hash(bytes) !== this.options.manifestSha256) throw new WorkerError('manifest_checksum_mismatch');
      const manifest = WorkerArtifactManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
      validateManifest(manifest, this.options.facts, expected);
      this.contentSha256 = workerArtifactContentSha256(manifest);
      this.target = manifest.target;
      this.statusValue.target = this.target;
      this.statusValue.contentSha256 = this.contentSha256;
      await migrateReleaseCompanionLauncher({ directory: this.options.releaseDirectory,
        stateDirectory: this.options.stateDirectory, assertStateOwnership: this.options.assertStateOwnership });
    }
    const retained = await readUpdateRecord(this.options.stateDirectory);
    if (retained) {
      this.record = retained;
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version,
        manifestSha256: this.options.manifestSha256, contentSha256: this.contentSha256, target: this.target });
      if (['pending', 'draining', 'downloading', 'installing'].includes(this.statusValue.state)) {
        await this.save({ state: 'failed', lastError: 'worker_update_interrupted' });
      }
    } else {
      await this.save({});
    }
    return this;
  }

  withUpdateRecord(operation) {
    // Serialize reads with writes so polling cannot replace a status being saved.
    const result = this.recordOperation.then(operation, operation);
    this.recordOperation = result;
    return result;
  }

  status() {
    return this.withUpdateRecord(async () => {
      const retained = await readUpdateRecord(this.options.stateDirectory);
      if (retained) {
        this.record = retained;
        this.statusValue = WorkerUpdateStatusSchema.parse({ ...retained.status, currentVersion: this.options.version,
          manifestSha256: this.options.manifestSha256, contentSha256: this.contentSha256, target: this.target });
        await this.recoverAdmission(retained);
      }
      return { ...this.statusValue };
    });
  }

  async recoverAdmission(record) {
    const plan = record.restart;
    if (!this.handoff || record.status.state !== 'failed' || plan?.requestId !== this.handoff
      || record.supervisorStarted !== this.handoff
      || !record.outcomes?.some(outcome => outcome.requestId === this.handoff && outcome.status.state === 'failed')) return;
    this.options.assertStateOwnership();
    const unchanged = plan.restartAttempted === false
      && plan.previousVersion === this.options.version
      && plan.workerInstallationId === this.options.workerInstallationId
      && plan.previousDirectory === this.options.releaseDirectory
      && await workerPointerMatches(plan.pointer, this.options.releaseDirectory);
    this.options.assertStateOwnership();
    if (unchanged) {
      this.options.resume();
      this.handoff = undefined;
      return;
    }
    this.statusValue = { ...this.statusValue, lastError: 'worker_update_recovery_required' };
  }

  save(change, details = {}) {
    return this.withUpdateRecord(async () => {
      this.options.assertStateOwnership();
      this.statusValue = WorkerUpdateStatusSchema.parse({ ...this.statusValue, ...change,
        manifestSha256: this.options.manifestSha256, contentSha256: this.contentSha256, target: this.target });
      const retained = await readUpdateRecord(this.options.stateDirectory);
      this.record = { ...retained, ...details, format: 1, status: this.statusValue };
      if (this.statusValue.lastError === null) delete this.record.failureCode;
      await writeUpdateRecord(this.options.stateDirectory, this.record);
    });
  }

  async maintenanceOutcome(task, deadlineAt) {
    const record = await readUpdateRecord(this.options.stateDirectory);
    const outcome = (record?.outcomes ?? []).find(value => value.status.targetVersion === task.workerTargetVersion
      && Date.parse(value.finishedAt) >= Date.parse(task.startedAt)
      && (deadlineAt === undefined || Date.parse(value.finishedAt) <= Date.parse(deadlineAt)));
    return outcome ? WorkerUpdateStatusSchema.parse(outcome.status) : null;
  }

  ready() {
    if (this.closed) return;
    this.pendingReadyCheck = true;
    this.scheduleCheck();
    this.timer ??= setInterval(() => this.scheduleCheck(), this.options.checkIntervalMs ?? 60_000);
    this.timer.unref();
  }

  scheduleCheck() {
    if (this.active || this.checking || this.closed) return;
    const reconnected = this.pendingReadyCheck;
    this.pendingReadyCheck = false;
    const check = this.status().then(status => {
      if (this.closed) return;
      if (status.state === 'restarting') {
        return (this.options.recoverSupervisor ?? recoverPendingWorkerUpdate)(this.options.stateDirectory,
          { signal: this.lifetime.signal });
      }
      return this.start({ retry: Boolean(reconnected && status.lastError === 'worker_update_failed') });
    });
    this.checking = check;
    this.operations.add(check);
    const finished = () => {
      this.checking = undefined;
      this.operations.delete(check);
    };
    void check.then(finished, error => {
      finished();
      this.options.reportError?.(error);
    });
  }

  start({ retry = false } = {}) {
    if (this.active) return this.active;
    if (this.closed) return Promise.reject(new WorkerError('worker_updater_closed'));
    const task = this.update(retry);
    this.active = task;
    const finished = () => {
      this.active = undefined;
      if (this.pendingReadyCheck) this.scheduleCheck();
    };
    void task.then(finished, finished);
    return task;
  }

  retryableFailure() {
    return automaticRetryErrors.has(this.record?.failureCode ?? this.statusValue.lastError);
  }

  async update(retry) {
    const deadline = new AbortController();
    const timeoutMs = this.options.attemptTimeoutMs ?? WORKER_UPDATE_ATTEMPT_TIMEOUT_MS;
    const attemptDeadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => deadline.abort(new WorkerError('worker_update_deadline_exceeded',
      `Worker update attempt exceeded ${timeoutMs} ms.`)), timeoutMs);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal]);
    try {
      return await this.performUpdate(retry, signal, attemptDeadlineAt);
    } finally {
      clearTimeout(timer);
    }
  }

  async performUpdate(retry, signal, attemptDeadlineAt) {
    const { stateDirectory, version, facts, connection, drain, resume, assertStateOwnership } = this.options;
    const run = operation => waitForUpdateOperation(() => {
      const pending = operation();
      this.operations.add(pending);
      void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
      return pending;
    }, signal);
    await this.status();
    signal.throwIfAborted();
    if (this.statusValue.state === 'restarting') throw new WorkerError('worker_update_restart_pending');
    if (this.statusValue.lastError === 'worker_update_recovery_required') {
      throw new WorkerError('worker_update_recovery_required');
    }
    const captured = connection()?.captureRequest(WORKER_UPDATE_NAMESPACE);
    if (!captured) {
      if (retry) throw new WorkerError('worker_update_channel_unavailable');
      return 'Worker update is unavailable on this Main connection.';
    }
    const request = async (payload, options = {}) => {
      try {
        const requestSignal = options.signal ? AbortSignal.any([signal, options.signal]) : signal;
        // Downloading can outlive a transport session; update requests use the live channel.
        const current = connection()?.captureRequest(WORKER_UPDATE_NAMESPACE);
        if (!current) throw new WorkerError('worker_update_channel_unavailable');
        return await run(() => current.request(payload, { timeoutMs: 60_000, signal: requestSignal }));
      } catch (error) {
        if (error instanceof DeviceApplicationError && error.code === 'WORKER_RELEASE_ASSET_UNAVAILABLE') {
          throw new WorkerError('WORKER_RELEASE_ASSET_UNAVAILABLE',
            'Main has not published and verified the GitHub Worker asset. Read computer maintenance for the reason.', { cause: error });
        }
        if (error instanceof DeviceApplicationError && error.code === 'WORKER_UPDATE_SMOKE_UNAVAILABLE') {
          throw new WorkerError('worker_update_smoke_unavailable',
            'Main cannot supply CI smoke configuration for this Worker release.', { cause: error });
        }
        const channelLost = error instanceof DeviceConnectionError && error.code !== 'revoked'
          || error instanceof DeviceApplicationError && ['unavailable', 'transport', 'timeout'].includes(error.code);
        if (channelLost) throw new WorkerError('worker_update_channel_unavailable', undefined, { cause: error });
        throw error;
      }
    };
    const target = Object.fromEntries(['os', 'osRelease', 'arch', 'libc', 'node'].map(key => [key, facts[key]]));
    const log = this.options.log ?? (() => {});
    let downloading;
    let phase = 'release';
    let targetFields = {};
    const enter = next => {
      phase = next;
      log(`Worker update ${next}`, { phase, ...targetFields });
    };
    let drained = false;
    try {
      const response = await request({ operation: 'release', target });
      const reply = WorkerArtifactReplySchema.parse(response.payload);
      if (reply.operation !== 'release' || response.bytes !== undefined) throw new WorkerError('artifact_release_invalid');
      if (!reply.release) throw new WorkerError('worker_update_target_unavailable');
      const release = reply.release;
      const manifest = WorkerArtifactManifestSchema.parse(release.manifest);
      validateManifest(manifest, facts, expected);
      if (manifest.version !== release.version) throw new WorkerError('manifest_version_mismatch');
      const contentSha256 = workerArtifactContentSha256(manifest);
      const sameContent = this.contentSha256 === contentSha256;
      if (sameContent) {
        const bytes = Buffer.from(`${JSON.stringify(release.manifest, null, 2)}\n`);
        if (hash(bytes) !== release.manifestSha256) throw new WorkerError('manifest_checksum_mismatch');
      }
      if (sameContent || release.version === version && release.manifestSha256 === this.options.manifestSha256) {
        if (retry || this.retryableFailure()
          || !['rolled-back', 'failed'].includes(this.statusValue.state)) {
          await this.save({ targetVersion: version, state: 'current', lastError: null });
        }
        return `Worker ${version} is current.`;
      }
      // Connection loss and interrupted shutdowns are safe to retry from the release manifest.
      if (!retry && (this.record?.manifestSha256 === release.manifestSha256
        || this.record?.contentSha256 === contentSha256)
        && ['failed', 'rolled-back'].includes(this.statusValue.state)
        && !this.retryableFailure()) {
        return 'Worker update needs a retry.';
      }
      targetFields = { targetVersion: release.version, manifestSha256: release.manifestSha256 };
      enter('release');
      const launch = await run(() => (this.options.locateLaunch ?? locateWorkerLaunch)(this.options));
      await this.save({ targetVersion: release.version, state: 'pending', lastError: null },
        { manifestSha256: release.manifestSha256, contentSha256, attemptDeadlineAt,
          downloadSource: null });
      // Download and verify while the Worker still admits work.
      // Only installation and restart need the drained runtime.
      enter('downloading');
      await this.save({ state: 'downloading' });
      downloading = await mkdtemp(join(stateDirectory, '.worker-download-'));
      await run(() => downloadWorkerArtifact({ release, directory: downloading, facts, signal,
        fetchAsset: this.options.fetchAsset,
        timeoutMs: this.options.downloadTimeoutMs, log: (msg, fields) => log(msg, { ...fields, ...targetFields }),
        onDownloadComplete: ({ source }) => this.save({}, { downloadSource: source }),
      }));
      signal.throwIfAborted();
      enter('smoke configuration');
      const ciSmoke = await run(() => readWorkerSmokeConfiguration(request, release.manifestSha256));
      enter('draining');
      await this.save({ state: 'draining' });
      drained = true;
      await run(() => drain(signal));
      signal.throwIfAborted();
      assertStateOwnership();
      enter('installing');
      await this.save({ state: 'installing' });
      const installed = await run(() => (this.options.stage ?? stageRunningVersion)({ root: launch.root, stateDirectory,
        artifact: downloading, approvedManifestSha256: release.manifestSha256, facts, expected,
        assertStateOwnership, updatePolicy: async () => true, signal }));
      signal.throwIfAborted();
      assertStateOwnership();
      this.handoff = randomUUID();
      await this.save({ state: 'restarting' }, { restart: { ...launch, directory: installed.directory,
        ...(ciSmoke ? { ciSmoke } : {}),
        requestId: this.handoff, restartAttempted: false, previousVersion: version,
        workerInstallationId: this.options.workerInstallationId } });
      enter('restarting');
      await (this.options.launchSupervisor ?? launchUpdateSupervisor)(stateDirectory);
      return `Worker ${release.version} restart is scheduled.`;
    } catch (error) {
      // A launched helper may still restart this service; only its reconciled outcome can reopen work.
      if (error?.code === 'worker_update_supervisor_handoff_pending') throw error;
      let failureCode = error instanceof WorkerError ? error.code : 'worker_update_failed';
      if (error?.code === 'WORKER_UPDATE_DRAIN_DEADLINE_EXCEEDED') failureCode = 'worker_update_drain_deadline_exceeded';
      if (this.lifetime.signal.aborted) failureCode = 'worker_updater_stopped';
      const lastError = error instanceof WorkerError && error.message === error.code ? failureCode
        : `${failureCode}: ${phase}: ${workerUpdateErrorMessage(error)}`.slice(0, 2000);
      if (drained) resume();
      await this.save({ state: 'failed', lastError }, { failureCode });
      if (targetFields.targetVersion) log('Worker update failed', { phase, ...targetFields, error: lastError });
      throw new WorkerError(failureCode, lastError, { cause: error });
    } finally {
      if (downloading) await rm(downloading, { recursive: true, force: true });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.lifetime.abort(new WorkerError('worker_updater_stopped'));
    // Keep the state lock until physical staging and downloads have stopped using their private files.
    return Promise.allSettled([this.active, ...this.operations]).then(results => {
      for (const result of results) {
        if (result.status === 'rejected') this.options.reportError?.(result.reason);
      }
    });
  }
}
