import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, readFile, lstat, realpath, copyFile, chmod, open, rename, symlink, readlink, readdir, rm, statfs } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { WorkerError, requirePrivateDirectory } from './diagnostics.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { migratePinnedCompanionLauncher } from './companionLauncher.mjs';
import { prepareBundledBrowserRuntime, activateBrowserRuntime, rollbackBrowserRuntime,
  offlineBrowserRuntimeLifecycle, readBrowserRuntimeActivation, readInstalledBrowserRuntime,
  writeBrowserRuntimeStatus } from './browserRuntimeInstall.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const version = /^\d+\.\d+\.\d+$/;
export function validateManifest(manifest, facts, expected) {
  if (manifest.format !== 1 || !version.test(manifest.version) || !/^[a-f0-9]{40}$/.test(manifest.commit) || !digest.test(manifest.lockfileSha256) || !manifest.target) throw new WorkerError('manifest_invalid');
  if (manifest.protocolVersion !== expected.protocolVersion || manifest.identityFormat !== expected.identityFormat) throw new WorkerError('protocol_or_identity_unsupported');
  if (facts.os !== 'ubuntu' || manifest.target.os !== facts.os || manifest.target.osRelease !== facts.osRelease || manifest.target.arch !== facts.arch || manifest.target.libc !== facts.libc || manifest.target.node !== facts.node) throw new WorkerError('target_runtime_mismatch');
  if (!facts.rootPersistent || !facts.homePersistent || facts.storagePersistent === false) throw new WorkerError('nonpersistent_storage');
  if (manifest.packageManager !== 'pnpm@11.27.0' || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 512) throw new WorkerError('manifest_invalid');
  const names = new Set();
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_@./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some((part) => !part || part === '.' || part === '..') || !digest.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 64 * 1024 * 1024 || names.has(file.path)) throw new WorkerError('manifest_invalid');
    names.add(file.path);
  }
  if (!names.has('src/cli.mjs')) throw new WorkerError('entrypoint_missing');
}

async function switchLink(root, name, target) {
  const temporary = join(root, `.${name}-${randomUUID()}`);
  try { await symlink(target, temporary); await rename(temporary, join(root, name)); await syncDirectory(root); }
  finally { await rm(temporary, { force: true }); }
}

async function syncDirectory(path) {
  const handle = await open(path, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}

async function syncArtifactDirectories(stage, files) {
  const directories = new Set([stage]);
  for (const file of files) {
    let directory = dirname(join(stage, file.path));
    while (directory !== stage) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  // Persist child entries before making their parent directory reachable.
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await syncDirectory(directory);
  }
}

async function verifyRelease(directory, approvedHash) {
  await requirePrivateDirectory(directory);
  const bytes = await readFile(join(directory, 'manifest.json'));
  if (hash(bytes) !== approvedHash) throw new WorkerError('installation_invalid');
  const manifest = JSON.parse(bytes);
  const base = await realpath(directory);
  for (const file of manifest.files) {
    const source = join(directory, file.path);
    if (!(await lstat(source)).isFile() || !(await realpath(source)).startsWith(`${base}/`)) throw new WorkerError('artifact_file_invalid');
    const content = await readFile(source);
    if (hash(content) !== file.sha256 || content.length !== file.size) throw new WorkerError('artifact_checksum_mismatch');
  }
  return manifest;
}

export async function readInstalledRelease({ root, facts, expected }) {
  await requirePrivateDirectory(root);
  const current = await readlink(join(root, 'current'));
  if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(current)) throw new WorkerError('installation_invalid');
  const manifestSha256 = current.slice(-64);
  const manifest = await verifyRelease(join(root, current), manifestSha256);
  validateManifest(manifest, facts, expected);
  return { manifest, manifestSha256, directory: join(root, current) };
}

export async function withInstallLock(root, fn) {
  const created = await mkdir(root, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(root);
  if (created) {
    const parent = dirname(created);
    let directory = root;
    while (directory !== parent) {
      await syncDirectory(directory);
      directory = dirname(directory);
    }
    await syncDirectory(parent);
  }
  const lock = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await new Promise((resolve, reject) => {
      // flock locks the inherited open file description until this process closes its descriptor.
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'inherit', lock.fd],
      });
      let failure;
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        if (failure) reject(failure);
        else if (code === 0) resolve();
        else reject(new WorkerError(code === 1 ? 'install_busy' : 'installation_lock_failed'));
      });
    });
    return await fn();
  } finally { await lock.close(); }
}

async function installationState(root, stateDirectory) {
  if (!isAbsolute(stateDirectory ?? '')) throw new WorkerError('separate_private_roots_required');
  await requirePrivateDirectory(root);
  await requirePrivateDirectory(stateDirectory);
  const app = await realpath(root);
  const state = await realpath(stateDirectory);
  if (app === state || app.startsWith(`${state}/`) || state.startsWith(`${app}/`)) {
    throw new WorkerError('separate_private_roots_required');
  }
  return state;
}

export async function requireInstallationState({ root, stateDirectory }) {
  const state = await installationState(root, stateDirectory);
  const path = join(root, 'state-directory.json');
  let binding;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new WorkerError('installation_invalid');
    }
    binding = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new WorkerError('installation_state_unbound', undefined, { cause: error });
    throw error;
  }
  if (binding.format !== 1 || binding.stateDirectory !== state) {
    throw new WorkerError('installation_state_mismatch');
  }
  return state;
}

export async function requireReleaseState({ directory, stateDirectory }) {
  const release = await realpath(directory);
  const versions = dirname(release);
  if (basename(versions) === 'versions' && /^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(basename(release))) {
    await requireInstallationState({ root: dirname(versions), stateDirectory });
  }
}

async function bindInstallationState(root, stateDirectory) {
  const handle = await open(join(root, 'state-directory.json'), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ format: 1, stateDirectory })}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
}

async function prepareInstallation(root, stateDirectory) {
    const state = await installationState(root, stateDirectory);
    let bound = true;
    try {
      await requireInstallationState({ root, stateDirectory });
    } catch (error) {
      if (error.code !== 'installation_state_unbound') throw error;
      try {
        await lstat(join(root, 'current'));
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
        bound = false;
      }
      if (bound) throw error;
    }
    return { state, bound };
}

export async function installVersion(options) {
  const { root, stateDirectory, publishInstallation } = options;
  return withInstallLock(root, async () => {
    const { state, bound } = await prepareInstallation(root, stateDirectory);
    const unlock = await acquireWorkerLock(state);
    try {
      const result = await installRelease(options, state, bound);
      if (publishInstallation) await publishInstallation(result);
      await removeObsoleteWorkerVersions(root, state, [result.directory]);
      return result;
    } finally {
      await unlock();
    }
  });
}

export async function stageRunningVersion(options) {
  return withInstallLock(options.root, async () => {
    options.assertStateOwnership();
    const { state, bound } = await prepareInstallation(options.root, options.stateDirectory);
    const result = await installRelease({ ...options, stageOnly: true }, state, bound);
    options.assertStateOwnership();
    await migratePinnedCompanionLauncher(options.root);
    return result;
  });
}

export async function migrateReleaseCompanionLauncher({ directory, stateDirectory, assertStateOwnership }) {
  const release = await realpath(directory);
  const versions = dirname(release);
  if (basename(versions) !== 'versions' || !/^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(basename(release))) return;
  const root = dirname(versions);
  await withInstallLock(root, async () => {
    assertStateOwnership();
    await requireInstallationState({ root, stateDirectory });
    await migratePinnedCompanionLauncher(root);
  });
}

async function installRelease({ root, artifact, approvedManifestSha256, facts, expected, updatePolicy, stageOnly,
  browserPreparation, browserRuntimeLifecycle, browserRuntimeReadiness, signal }, state, bound) {
  const bytes = await readFile(join(artifact, 'manifest.json'));
  if (!digest.test(approvedManifestSha256) || hash(bytes) !== approvedManifestSha256) throw new WorkerError('manifest_checksum_mismatch');
  const manifest = JSON.parse(bytes);
  validateManifest(manifest, facts, expected);
  const prepareBrowser = async directory => {
    const prepared = browserPreparation ?? await prepareBundledBrowserRuntime({ root, artifact: directory, manifest,
      target: facts, signal, readiness: browserRuntimeReadiness });
    const browserRuntime = prepared.runtime;
    if (prepared.failure) {
      const browserRuntimeStatus = await writeBrowserRuntimeStatus(root, { state: 'failed', retryable: true,
        manifestSha256: approvedManifestSha256, reason: prepared.failure.reason });
      console.warn(`Worker installed; browser runtime setup failed: ${prepared.failure.reason}`);
      return { browserRuntimeStatus };
    }
    const lifecycle = browserRuntimeLifecycle ?? (!stageOnly && browserRuntime
      ? await offlineBrowserRuntimeLifecycle({ nativeHostModule: browserRuntime.nativeHostModule,
        profileStateRoot: join(state, 'browser', 'profile-data') }) : undefined);
    const browserActivation = !stageOnly && browserRuntime
      ? await activateInstalledBrowser(root, browserRuntime, lifecycle, signal) : undefined;
    const browserRuntimeStatus = await writeBrowserRuntimeStatus(root, { state: browserRuntime ? (stageOnly ? 'staged' : 'ready') : 'failed',
      retryable: !browserRuntime, manifestSha256: approvedManifestSha256,
      reason: browserRuntime ? null : 'This release has no verified browser runtime. Retry after a matching runtime is available.' });
    return { browserRuntime, browserActivation, browserRuntimeStatus, lifecycle };
  };
  let current;
  try { current = await readlink(join(root, 'current')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(current)) throw new WorkerError('installation_invalid');
    if (hash(await readFile(join(root, current, 'manifest.json'))) === approvedManifestSha256) {
      await verifyRelease(join(root, current), approvedManifestSha256);
      const { browserRuntime, browserActivation, browserRuntimeStatus } = await prepareBrowser(join(root, current));
      return { version: manifest.version, manifestSha256: approvedManifestSha256,
        directory: join(root, current), browserRuntime, browserActivation, browserRuntimeStatus };
    }
    const previous = JSON.parse(await readFile(join(root, current, 'manifest.json'), 'utf8'));
    if (!stageOnly && manifest.version === previous.version && manifest.commit !== previous.commit) {
      throw new WorkerError('release_order_unknown');
    }
    const incoming = manifest.version.split('.').map(Number), installed = previous.version.split('.').map(Number);
    const differing = incoming.findIndex((n, i) => n !== installed[i]);
    if (!stageOnly && differing >= 0 && incoming[differing] < installed[differing]) throw new WorkerError('downgrade_refused');
    if (!updatePolicy || await updatePolicy({ from: previous.version, to: manifest.version }) !== true) throw new WorkerError('update_not_approved');
  }
  const releases = join(root, 'versions');
  await mkdir(releases, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(releases);
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < manifest.files.reduce((sum, file) => sum + file.size, bytes.length) + 1024 * 1024) throw new WorkerError('disk_full');
  const stage = join(releases, `.stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  try {
    const base = await realpath(artifact);
    for (const file of manifest.files) {
      const source = join(artifact, file.path);
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || !(await realpath(source)).startsWith(`${base}/`)) throw new WorkerError('artifact_file_invalid');
      const content = await readFile(source);
      if (content.length !== file.size || hash(content) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
      const target = join(stage, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      // Verify copied bytes as well, closing source mutation between verification and copy.
      if (hash(await readFile(target)) !== file.sha256) throw new WorkerError('artifact_checksum_mismatch');
      await chmod(target, file.path === 'artifacts/job-quota-query' ? 0o700 : 0o600);
      const handle = await open(target, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    }
    const mf = await open(join(stage, 'manifest.json'), 'wx', 0o600); try { await mf.writeFile(bytes); await mf.sync(); } finally { await mf.close(); }
    const release = `${manifest.version}-${approvedManifestSha256}`;
    await syncArtifactDirectories(stage, manifest.files);
    try { await rename(stage, join(releases, release)); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await verifyRelease(join(releases, release), approvedManifestSha256);
    }
    await syncDirectory(releases);
    if (!bound) await bindInstallationState(root, state);
    const { lifecycle, ...browser } = await prepareBrowser(join(releases, release));
    const { browserActivation } = browser;
    if (!stageOnly) {
      try {
        if (current) await switchLink(root, 'previous', current);
        await switchLink(root, 'current', `versions/${release}`);
      } catch (error) {
        if (browserActivation) await rollbackBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), ...browserActivation,
          drain: lifecycle.stop ?? (async () => undefined), restoreProfiles: lifecycle.restoreProfiles });
        throw error;
      }
    }
    return { version: manifest.version, manifestSha256: approvedManifestSha256,
      directory: join(releases, release), ...browser };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

async function activateInstalledBrowser(root, staged, lifecycle, signal) {
  let prepared;
  try {
    return await activateBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), staged, signal,
      drain: lifecycle.drain, onPrepared: receipt => { prepared = receipt; } });
  } catch (error) {
    if (prepared) await rollbackBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), ...prepared,
      drain: lifecycle.stop ?? (async () => undefined), restoreProfiles: lifecycle.restoreProfiles });
    throw error;
  }
}

export async function readRetainedRelease(root) {
  const previous = await readlink(join(root, 'previous'));
  if (!/^versions\/\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(previous)) throw new WorkerError('rollback_invalid');
  const manifest = await verifyRelease(join(root, previous), previous.slice(-64));
  return { manifest, directory: join(root, previous) };
}

export async function rollbackVersion({ root, stateDirectory, approveStop, facts, expected }) {
  return withInstallLock(root, async () => {
    const state = await requireInstallationState({ root, stateDirectory });
    const unlock = await acquireWorkerLock(state);
    try {
      if (!approveStop || await approveStop() !== true) throw new WorkerError('update_not_approved');
      const retained = await readRetainedRelease(root);
      validateManifest(retained.manifest, facts, expected);
      const activation = await readBrowserRuntimeActivation(join(root, 'browser-runtime'));
      const retainedRuntime = retained.manifest.browserRuntime?.manifestSha256;
      const currentRuntime = activation ? await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), target: facts }) : null;
      if (currentRuntime?.manifestSha256 !== retainedRuntime && activation?.changed && activation.state !== 'rolled-back') {
        if (activation.previousReference !== (retainedRuntime ? `versions/${retainedRuntime}` : null)) {
          throw new WorkerError('browser_runtime_rollback_unavailable');
        }
        const lifecycle = await offlineBrowserRuntimeLifecycle({ nativeHostModule: activation.nativeHostModule,
          profileStateRoot: activation.profileStateRoot });
        await rollbackBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), ...activation,
          drain: async () => undefined, restoreProfiles: lifecycle.restoreProfiles });
      }
      const previous = await readlink(join(root, 'previous'));
      await switchLink(root, 'current', previous);
    } finally {
      await unlock();
    }
  });
}

export async function pruneWorkerVersions({ root, stateDirectory }) {
  return withInstallLock(root, async () => {
    const state = await requireInstallationState({ root, stateDirectory });
    await removeObsoleteWorkerVersions(root, state);
  });
}

async function removeObsoleteWorkerVersions(root, stateDirectory, retained = []) {
  const versions = await realpath(join(root, 'versions'));
  const keep = new Set(await Promise.all(retained.map(path => realpath(path))));
  const hashes = new Set();
  for (const name of ['current', 'previous']) {
    try {
      await lstat(join(root, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    keep.add(await realpath(join(root, name)));
  }
  try {
    const path = join(stateDirectory, 'worker-update.json');
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new WorkerError('worker_update_state_invalid');
    }
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (record?.format !== 1) throw new WorkerError('worker_update_state_invalid');
    await retainUpdateReferences(record, keep, hashes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await retainWorkflowSdkRelease(stateDirectory, keep, hashes);
  for (const entry of await readdir(versions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+-[a-f0-9]{64}$/.test(entry.name)) continue;
    const path = join(versions, entry.name);
    const referenced = [...keep].some(reference => reference === path || reference.startsWith(`${path}/`));
    if (referenced || hashes.has(entry.name.slice(-64))) continue;
    await rm(path, { recursive: true, force: true });
  }
  await syncDirectory(versions);
}

// Offline updates can prune before the running Worker validates and publishes its replacement SDK selection.
async function retainWorkflowSdkRelease(stateDirectory, keep, hashes) {
  const path = join(stateDirectory, 'workflow-runtime.json');
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)
    || info.nlink !== 1 || info.size > 65_536) throw new WorkerError('workflow_selection_invalid');
  const selection = JSON.parse(await readFile(path, 'utf8'));
  if (selection?.schemaVersion !== 1) throw new WorkerError('workflow_selection_invalid');
  for (const path of [selection.claude?.sdkEntrypoint, selection.claude?.installedLockPath]) {
    if (typeof path !== 'string' || !isAbsolute(path)) continue;
    // The selected SDK can be missing during replacement, while its release directory still exists.
    const release = /^(.*\/versions\/\d+\.\d+\.\d+-[a-f0-9]{64})(?:\/|$)/u.exec(path)?.[1];
    await retainUpdateReferences([path, release], keep, hashes);
  }
}

async function retainUpdateReferences(value, keep, hashes) {
  if (typeof value === 'string') {
    if (digest.test(value)) hashes.add(value);
    if (isAbsolute(value)) {
      keep.add(value);
      try {
        keep.add(await realpath(value));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) await retainUpdateReferences(child, keep, hashes);
  }
}
