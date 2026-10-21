import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, open, rename, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WorkerError, requirePrivateDirectory, workerUpdateErrorMessage } from './diagnostics.mjs';
import { pruneWorkerVersions } from './installation.mjs';
import { readWorkerStatus } from './runtime.mjs';
import { WORKER_UPDATE_STARTUP_TIMEOUT_MS } from './ciSmokeTiming.mjs';
import { waitForUpdateOperation } from './updateOperation.mjs';
import { offlineBrowserRuntimeLifecycle, rollbackBrowserRuntime, readInstalledBrowserRuntime,
  pruneBrowserRuntimeVersions } from './browserRuntimeInstall.mjs';

const execute = promisify(execFile);
const services = ['graphql-worker.service', 'foreman-ci-worker.service'];
const supervisorUnitPattern = /^foreman-worker-update-[a-f0-9-]{36}$/;
const environment = () => ({ PATH: '/usr/bin:/bin', HOME: process.env.HOME,
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS });

export async function writeUpdateRecord(stateDirectory, record) {
  await requirePrivateDirectory(stateDirectory);
  const temporary = join(stateDirectory, `.worker-update-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(stateDirectory, 'worker-update.json'));
    await syncDirectory(stateDirectory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readUpdateRecord(stateDirectory) {
  await requirePrivateDirectory(stateDirectory);
  const path = join(stateDirectory, 'worker-update.json');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new WorkerError('worker_update_state_invalid');
    }
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record.format !== 1) throw new WorkerError('worker_update_state_invalid');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function locateWorkerLaunch({ stateDirectory, releaseDirectory, home = process.env.HOME,
  pid = process.pid, run = execute }) {
  let service;
  for (const candidate of services) {
    let result;
    try {
      result = await run('/usr/bin/systemctl', ['--user', 'show', candidate, '--property=MainPID', '--value'],
        { timeout: 5000, maxBuffer: 4096, env: environment() });
    } catch (error) {
      if (error.code === 1) continue;
      throw error;
    }
    if (Number(result.stdout.trim()) === pid) service = candidate;
  }
  if (!service) throw new WorkerError('worker_update_supervisor_unavailable');
  const directory = await realpath(releaseDirectory);
  if (service === 'foreman-ci-worker.service') {
    const path = join(home, '.local', 'share', 'foreman-code', 'ci-verification', 'worker-release-path');
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022)) {
      throw new WorkerError('worker_release_pointer_invalid');
    }
    if (await realpath((await readFile(path, 'utf8')).trim()) !== directory) {
      throw new WorkerError('worker_release_pointer_mismatch');
    }
    return { service, pointer: { kind: 'file', path }, previousDirectory: directory,
      root: join(dirname(path), 'worker-updates'), stateDirectory };
  }
  const root = dirname(dirname(directory));
  if (basename(dirname(directory)) !== 'versions' || await realpath(join(root, 'current')) !== directory) {
    throw new WorkerError('worker_release_pointer_mismatch');
  }
  return { service, pointer: { kind: 'symlink', path: join(root, 'current') },
    previousDirectory: directory, root, stateDirectory,
    unitPath: join(home, '.config', 'systemd', 'user', 'graphql-worker.service') };
}

export async function migrateWorkerService(plan, { run = execute } = {}) {
  if (plan.service !== 'graphql-worker.service') return;
  const info = await lstat(plan.unitPath);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o022)) {
    throw new WorkerError('worker_update_service_invalid');
  }
  const options = { timeout: 5000, maxBuffer: 4096, env: environment() };
  const fragment = await run('/usr/bin/systemctl',
    ['--user', 'show', plan.service, '--property=FragmentPath', '--value'], options);
  const dropIns = await run('/usr/bin/systemctl',
    ['--user', 'show', plan.service, '--property=DropInPaths', '--value'], options);
  if (await realpath(fragment.stdout.trim()) !== await realpath(plan.unitPath) || dropIns.stdout.trim()) {
    throw new WorkerError('worker_update_service_unsupported');
  }
  const unit = await readFile(plan.unitPath, 'utf8');
  const starts = [...unit.matchAll(/^ExecStart=(\S+) (\S+) run --state (\S+)$/gm)];
  if (starts.length !== 1 || starts[0][3] !== plan.stateDirectory) {
    throw new WorkerError('worker_update_service_unsupported');
  }
  const [line, node, entrypoint] = starts[0];
  const stable = join(plan.root, 'current', 'src', 'cli.mjs');
  if (entrypoint === stable) {
    await run('/usr/bin/systemctl', ['--user', 'daemon-reload'], options);
    return;
  }
  if (entrypoint !== join(plan.previousDirectory, 'src', 'cli.mjs')) {
    throw new WorkerError('worker_update_service_unsupported');
  }
  const temporary = `${plan.unitPath}.${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(unit.replace(line, `ExecStart=${node} ${stable} run --state ${plan.stateDirectory}`));
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await rename(temporary, plan.unitPath);
    await syncDirectory(dirname(plan.unitPath));
  } finally { await rm(temporary, { force: true }); }
  await run('/usr/bin/systemctl', ['--user', 'daemon-reload'], options);
}

export async function switchWorkerPointer(pointer, directory) {
  const parent = dirname(pointer.path);
  const temporary = join(parent, `.worker-release-${randomUUID()}`);
  try {
    if (pointer.kind === 'symlink') {
      await symlink(relative(parent, directory), temporary);
    } else if (pointer.kind === 'file') {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${directory}\n`);
        await handle.sync();
      } finally { await handle.close(); }
    } else {
      throw new WorkerError('worker_release_pointer_invalid');
    }
    await rename(temporary, pointer.path);
    await syncDirectory(parent);
  } finally { await rm(temporary, { force: true }); }
}

export async function workerPointerMatches(pointer, directory) {
  try {
    const info = await lstat(pointer.path);
    if (info.uid !== process.getuid()) return false;
    if (pointer.kind === 'symlink' && info.isSymbolicLink()) {
      return await realpath(pointer.path) === await realpath(directory);
    }
    if (pointer.kind === 'file' && info.isFile() && !(info.mode & 0o022)) {
      return await realpath((await readFile(pointer.path, 'utf8')).trim()) === await realpath(directory);
    }
    return false;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) return false;
    throw error;
  }
}

export async function waitForWorkerReady({ stateDirectory, version, workerInstallationId,
  timeoutMs = 60_000, pollMs = 250, readStatus = readWorkerStatus, signal }) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastProbeError;
  do {
    signal?.throwIfAborted();
    let status;
    try {
      status = await readStatus(stateDirectory);
    } catch (error) {
      if (!['worker_status_timeout', 'ECONNRESET', 'ECONNREFUSED', 'ENOENT', 'EPIPE', 'ETIMEDOUT']
        .includes(error.code)) throw error;
      lastProbeError = error;
    }
    if (status) lastStatus = status;
    if (status?.phase === 'blocked' && status.failure) throw new Error(status.failure);
    if (status?.active === true && status.phase === 'ready' && status.appVersion === version
      && status.workerInstallationId === workerInstallationId) return;
    await wait(pollMs, undefined, { signal });
  } while (Date.now() < deadline);
  const observed = lastStatus
    ? `phase=${lastStatus.phase}, failure=${lastStatus.failure ?? 'none'}, version=${lastStatus.appVersion ?? 'unknown'}`
    : 'no running Worker status';
  const probeFailure = lastProbeError ? ` Last status probe: ${workerUpdateErrorMessage(lastProbeError)}.` : '';
  throw new WorkerError('worker_update_startup_timeout',
    `worker_update_startup_timeout: Worker ${version} did not become ready; ${observed}.${probeFailure}`);
}

async function readWorkerStartupFailure(plan, since) {
  const result = await execute('/usr/bin/journalctl', ['--user', '-u', plan.service, '--since', since,
    '--no-pager', '-o', 'cat', '-n', '30'], { timeout: 5000, maxBuffer: 65_536, env: environment() });
  return result.stdout.trim().slice(-1200);
}

export async function superviseWorkerUpdate(record, ports = {}) {
  const { stop = async service => {
    await execute('/usr/bin/systemctl', ['--user', 'stop', service],
      { timeout: 30_000, maxBuffer: 4096, env: environment() });
  }, restart = async (service, { signal } = {}) => {
    await execute('/usr/bin/systemctl', ['--user', 'reset-failed', service],
      { timeout: 5000, maxBuffer: 4096, env: environment(), signal });
    await execute('/usr/bin/systemctl', ['--user', 'restart', service],
      { timeout: 30_000, maxBuffer: 4096, env: environment(), signal });
  }, ready = waitForWorkerReady, switchPointer = switchWorkerPointer,
  prepareService = migrateWorkerService, persist = writeUpdateRecord,
  browserReady = async runtime => {
    const installed = await readInstalledBrowserRuntime({ runtimeRoot: runtime.runtimeRoot, target: runtime.target });
    if (installed.manifestSha256 !== runtime.manifestSha256) throw new WorkerError('browser_runtime_cutover_mismatch');
  }, browserRollback = async runtime => {
    const lifecycle = await offlineBrowserRuntimeLifecycle(runtime);
    // The service is stopped before this callback. Profile restoration verifies native writer exit.
    await rollbackBrowserRuntime({ ...runtime, drain: async () => undefined, restoreProfiles: lifecycle.restoreProfiles });
  },
  readStartupFailure = ports.restart ? async () => '' : readWorkerStartupFailure,
  smoke = async (plan, { signal }) => {
    if (!plan.ciSmoke) return;
    if (process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1') {
      process.stderr.write('Worker CI smoke explicitly skipped (FOREMAN_INSTALL_SKIP_CI_SMOKE=1).\n');
      return;
    }
    const { runInstalledCiSmoke } = await import(pathToFileURL(join(plan.directory, 'src/worker.mjs')));
    signal.throwIfAborted();
    await runInstalledCiSmoke(plan.ciSmoke, { signal });
  } } = ports;
  const plan = record.restart;
  if (!plan || !services.includes(plan.service)) throw new WorkerError('worker_update_state_invalid');
  const controller = new AbortController();
  const signal = controller.signal;
  const remainingMs = record.attemptDeadlineAt - Date.now();
  const expire = () => controller.abort(new WorkerError('worker_update_deadline_exceeded'));
  let timer;
  // Older update records retain the bounded restart, readiness and smoke budgets.
  if (record.attemptDeadlineAt !== undefined) {
    if (!Number.isFinite(record.attemptDeadlineAt) || remainingMs <= 0) expire();
    else timer = setTimeout(expire, remainingMs);
  }
  const run = operation => waitForUpdateOperation(operation, signal);
  const previousManifestSha256 = record.status.manifestSha256;
  const previousContentSha256 = record.status.contentSha256;
  const save = async (state, currentVersion, lastError) => {
    const manifestSha256 = state === 'current' ? record.manifestSha256 : previousManifestSha256;
    const contentSha256 = state === 'current' ? record.contentSha256 : previousContentSha256;
    record.status = { ...record.status, state, currentVersion, manifestSha256, contentSha256, lastError };
    const outcome = { requestId: plan.requestId, status: record.status, finishedAt: new Date().toISOString() };
    record.outcomes = [...(record.outcomes ?? []).filter(value => value.requestId !== plan.requestId), outcome].slice(-20);
    await persist(plan.stateDirectory, record);
  };
  let restartStartedAt;
  let waitingForReady = false;
  const restartWorker = async (options = {}) => {
    // A surviving process may resume only when neither restart was attempted.
    plan.restartAttempted = true;
    await persist(plan.stateDirectory, record);
    options.signal?.throwIfAborted();
    restartStartedAt = new Date().toISOString();
    await restart(plan.service, options);
  };
  try {
    signal.throwIfAborted();
    if (plan.browserRuntime?.state === 'rolled-back') throw new WorkerError('worker_update_rollback_pending');
    await prepareService(plan);
    signal.throwIfAborted();
    await switchPointer(plan.pointer, plan.directory);
    signal.throwIfAborted();
    if (plan.pointer.kind === 'symlink') {
      await switchPointer({ kind: 'symlink', path: join(plan.root, 'previous') }, plan.previousDirectory);
    }
    await run(() => restartWorker({ signal }));
    let startupTimeoutMs = plan.ciSmoke ? 60_000 : WORKER_UPDATE_STARTUP_TIMEOUT_MS;
    if (record.attemptDeadlineAt !== undefined) {
      startupTimeoutMs = Math.min(startupTimeoutMs, record.attemptDeadlineAt - Date.now());
    }
    waitingForReady = true;
    await run(() => ready({ stateDirectory: plan.stateDirectory, version: record.status.targetVersion,
      workerInstallationId: plan.workerInstallationId,
      signal, timeoutMs: startupTimeoutMs }));
    waitingForReady = false;
    if (plan.browserRuntime) await run(() => browserReady(plan.browserRuntime));
    await run(() => smoke(plan, { signal }));
    await save('current', record.status.targetVersion, null);
  } catch (error) {
    // Recovery keeps its own startup budget after the update attempt expires.
    clearTimeout(timer);
    let failure = workerUpdateErrorMessage(error);
    if (waitingForReady) {
      try {
        const stderr = await readStartupFailure(plan, restartStartedAt);
        if (stderr) failure = `${failure}; startup stderr: ${stderr}`.slice(0, 2000);
      } catch (diagnosticError) {
        process.stderr.write(`Worker startup diagnostics unavailable: ${workerUpdateErrorMessage(diagnosticError)}\n`);
      }
    }
    process.stderr.write(`Worker update failed: ${failure}\n`);
    try {
      if (plan.browserRuntime?.changed) {
        await stop(plan.service);
        await browserRollback(plan.browserRuntime);
        plan.browserRuntime.state = 'rolled-back';
        await persist(plan.stateDirectory, record);
      }
      await switchPointer(plan.pointer, plan.previousDirectory);
      await restartWorker();
      await ready({ stateDirectory: plan.stateDirectory, version: plan.previousVersion,
        workerInstallationId: plan.workerInstallationId });
      await save('rolled-back', plan.previousVersion, failure.slice(0, 2000));
    } catch (rollbackError) {
      const reason = workerUpdateErrorMessage(rollbackError);
      await save('failed', plan.previousVersion, `${failure.slice(-950)}; rollback: ${reason.slice(-950)}`);
      throw new WorkerError('worker_update_rollback_failed', undefined, { cause: rollbackError });
    }
  } finally {
    clearTimeout(timer);
  }
  if (record.status.state === 'current') {
    try {
      await pruneWorkerVersions({ root: plan.root, stateDirectory: plan.stateDirectory });
      if (plan.browserRuntime) await pruneBrowserRuntimeVersions(plan.browserRuntime.runtimeRoot);
    } catch (error) {
      // Cleanup failure does not undo a healthy update; the next update retries it.
      process.stderr.write(`Worker version cleanup failed: ${workerUpdateErrorMessage(error)}\n`);
    }
  }
}

export async function launchUpdateSupervisor(stateDirectory, { run = execute } = {}) {
  const helper = fileURLToPath(new URL('./update-supervisor-cli.mjs', import.meta.url));
  const record = await readUpdateRecord(stateDirectory);
  if (record?.status?.state !== 'restarting') throw new WorkerError('worker_update_state_invalid');
  let unit = record.restart.unit;
  // Reuse the manager's unit name so an earlier delayed launch cannot create a second helper.
  if (typeof unit !== 'string' || !supervisorUnitPattern.test(unit)) {
    unit = `foreman-worker-update-${randomUUID()}`;
    record.restart.unit = unit;
    delete record.supervisorStarted;
    await writeUpdateRecord(stateDirectory, record);
  }
  try {
    await run('/usr/bin/systemd-run', ['--user', '--collect', '--unit', unit, '--property=Type=exec',
      '--property=Restart=on-failure', '--property=RestartSec=1',
      ...(process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1' ? ['--setenv=FOREMAN_INSTALL_SKIP_CI_SMOKE=1'] : []),
      process.execPath, helper, stateDirectory], { timeout: 10_000, maxBuffer: 4096, env: environment() });
  } catch (error) {
    if (error.killed || error.signal || error.code === 'ETIMEDOUT') {
      throw new WorkerError('worker_update_supervisor_handoff_pending', undefined, { cause: error });
    }
    throw error;
  }
  try {
    const deadline = Date.now() + 10_000;
    do {
      const record = await readUpdateRecord(stateDirectory);
      if (record?.supervisorStarted && record.supervisorStarted === record.restart?.requestId) return;
      await wait(50);
    } while (Date.now() < deadline);
    throw new WorkerError('worker_update_supervisor_handoff_pending');
  } catch (cause) {
    throw new WorkerError('worker_update_supervisor_handoff_pending', undefined, { cause });
  }
}

export async function recoverPendingWorkerUpdate(stateDirectory, { run = execute,
  launch = launchUpdateSupervisor, signal } = {}) {
  signal?.throwIfAborted();
  const record = await readUpdateRecord(stateDirectory);
  if (record?.status?.state !== 'restarting') return;
  const unit = record.restart?.unit;
  if (typeof unit === 'string' && supervisorUnitPattern.test(unit)) {
    try {
      const result = await run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=ActiveState', '--value'],
        { timeout: 5000, maxBuffer: 4096, env: environment(), signal });
      if (!['inactive', 'failed', ''].includes(result.stdout.trim())) return;
    } catch (error) {
      if (error.code !== 1 && error.code !== 3 && error.code !== 4) throw error;
    }
  }
  signal?.throwIfAborted();
  await launch(stateDirectory);
}
