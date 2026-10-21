import { readFile, lstat, realpath } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export class WorkerError extends Error {
  constructor(code, message = code, options) { super(message, options); this.code = code; }
}

export function workerUpdateErrorMessage(error, depth = 0) {
  const message = error instanceof Error ? error.message : String(error);
  const details = [message.slice(-600)];
  if (typeof error?.stderr === 'string' && error.stderr.trim()) details.push(error.stderr.trim().slice(-1200));
  if (depth < 2) {
    if (error instanceof AggregateError) {
      details.push(...error.errors.slice(0, 3).map(value => workerUpdateErrorMessage(value, depth + 1)));
    } else if (error?.cause && error.cause !== error) {
      details.push(workerUpdateErrorMessage(error.cause, depth + 1));
    }
  }
  return details.join('; ').slice(-1800);
}

export function persistentFilesystems(mountInfo, home) {
  const mounts = mountInfo.trim().split('\n').flatMap((line) => {
    const [fields, tail] = line.split(' - ');
    if (!tail) return [];
    return [{ path: fields.split(' ')[4].replace(/\\040/g, ' '), type: tail.split(' ')[0] }];
  });
  const selected = (path) => mounts.filter((m) => path === m.path || path.startsWith(`${m.path === '/' ? '' : m.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const ephemeral = new Set(['overlay', 'aufs', 'tmpfs', 'ramfs', 'squashfs']);
  return { rootPersistent: !!selected('/') && !ephemeral.has(selected('/').type), homePersistent: !!selected(home) && !ephemeral.has(selected(home).type) };
}

async function physicalStoragePath(path) {
  let ancestor = resolve(path);
  const remaining = [];
  for (;;) {
    try { return join(await realpath(ancestor), ...remaining); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const existing = await lstat(ancestor).catch((failure) => { if (failure.code === 'ENOENT') return null; throw failure; });
      // An existing but unresolvable symlink is not proof of a new directory.
      if (existing || dirname(ancestor) === ancestor) throw error;
      remaining.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}

let libc;
function processLibc() {
  if (libc === undefined) {
    const version = process.report.getReport().header.glibcVersionRuntime;
    libc = version ? `glibc-${version}` : 'unknown';
  }
  return libc;
}

export async function hostFacts(home, storagePaths = []) {
  const os = await readFile('/etc/os-release', 'utf8');
  const values = Object.fromEntries(os.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1).replace(/^"|"$/g, '')]; }));
  const mounts = await readFile('/proc/self/mountinfo', 'utf8');
  const inspectionErrors = [];
  const [homePersistent, ...storagePersistent] = await Promise.all([home, ...storagePaths].map(async (path, index) => {
    try { return persistentFilesystems(mounts, await physicalStoragePath(path)).homePersistent; }
    catch (error) {
      const lastError = typeof error.code === 'string' ? error.code : 'STORAGE_INSPECTION_FAILED';
      inspectionErrors.push({ operation: index === 0 ? 'home storage' : 'state storage', lastError, failureCount: 1 });
      console.warn(JSON.stringify({ operation: 'inspect storage persistence', lastError, failureCount: 1 }));
      return false;
    }
  }));
  return { os: values.ID, osRelease: values.VERSION_ID, arch: process.arch, libc: processLibc(), node: process.version, ...persistentFilesystems(mounts, '/'), homePersistent, storagePersistent: storagePersistent.every(Boolean), inspectionErrors };
}

export async function requirePrivateDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new WorkerError('private_directory_required');
}

export function executableAvailability(path) {
  const inspectionErrors = [];
  const available = Object.fromEntries(['node', 'git', 'codex', 'claude', 'systemctl'].map(name => [name,
    path.split(':').filter(directory => directory.startsWith('/')).some(directory => {
      try { accessSync(join(directory, name), constants.X_OK); return true; }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        const lastError = typeof error.code === 'string' ? error.code : 'EXECUTABLE_INSPECTION_FAILED';
        inspectionErrors.push({ operation: `inspect ${name} executable`, lastError, failureCount: 1 });
        console.warn(JSON.stringify({ operation: `inspect ${name} executable`, status: 'degraded', lastError, failureCount: 1 }));
        return false;
      }
    })]));
  return { ...available, inspectionErrors };
}

// Explicit projection: errors, credentials, process arguments and arbitrary metadata never cross this boundary.
export function doctorReport({ facts, identity, connection, service, executables, errors = [] }) {
  return {
    inspectionErrors: [...(facts.inspectionErrors ?? []), ...(executables.inspectionErrors ?? [])],
    versions: { os: facts.os, osRelease: facts.osRelease, arch: facts.arch, libc: facts.libc, node: facts.node,
      app: /^\d+\.\d+\.\d+$/.test(facts.appVersion) ? facts.appVersion : null,
      protocol: Number.isSafeInteger(facts.protocolVersion) ? facts.protocolVersion : null,
      identityFormat: Number.isSafeInteger(facts.identityFormat) ? facts.identityFormat : null,
      commit: /^[a-f0-9]{40}$/.test(facts.commit) ? facts.commit : null,
      lockfileSha256: /^[a-f0-9]{64}$/.test(facts.lockfileSha256) ? facts.lockfileSha256 : null },
    persistentRoot: facts.rootPersistent, persistentHome: facts.homePersistent, persistentState: facts.storagePersistent ?? null,
    executables: Object.fromEntries(['node', 'git', 'codex', 'claude', 'systemctl'].map((key) => [key, executables[key] === true])),
    service: { active: service.active === true, userManagerAvailable: service.userManagerAvailable === true },
    identity: { installationId: identity?.workerInstallationId ?? null, selectedMainId: identity?.mainId ?? null, selectedMainFingerprint: identity?.mainPublicKeyFingerprint ?? null },
    pairing: identity?.deviceId ? 'paired' : 'unpaired',
    connection: ['connected', 'connecting', 'backoff', 'blocked', 'offline', 'stopped'].includes(connection?.state) ? connection.state : 'offline',
    errors: [...new Set([...errors, connection?.failure].filter((code) => SAFE_ERRORS.has(code)))],
  };
}

const SAFE_ERRORS = new Set(['worker_status_unavailable', 'manifest_missing', 'manifest_unreadable', 'manifest_invalid', 'nonpersistent_root', 'nonpersistent_home', 'private_directory_required', 'identity_invalid', 'identity_read_only', 'systemd_user_manager_missing', 'connection_unavailable', 'service_not_running', 'authentication', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport']);
