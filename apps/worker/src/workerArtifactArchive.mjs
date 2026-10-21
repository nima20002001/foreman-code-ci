import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createGunzip } from 'node:zlib';
import { WorkerArtifactManifestSchema, WORKER_UPDATE_MAX_JSON_BYTES }
  from '../../../packages/contracts/src/workerUpdate.ts';
import { WorkerError } from './diagnostics.mjs';

class ByteLimit extends Transform {
  constructor(limit, code) {
    super();
    this.remaining = limit;
    this.code = code;
  }

  _transform(chunk, _encoding, callback) {
    if (chunk.length > this.remaining) return callback(new WorkerError(this.code));
    this.remaining -= chunk.length;
    callback(null, chunk);
  }
}

export function workerArchiveLimits(manifest) {
  const directories = new Set(['']);
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let count = 1; count < parts.length; count++) directories.add(parts.slice(0, count).join('/'));
  }
  const contentBytes = manifest.files.reduce((total, file) => total + file.size, 0);
  const paddedBytes = manifest.files.reduce((total, file) => total + Math.ceil(file.size / 512) * 512, 0);
  const members = manifest.files.length + directories.size + 1;
  // GNU long-name metadata and record padding are bounded along with member data.
  const expandedBytes = paddedBytes + WORKER_UPDATE_MAX_JSON_BYTES + members * 2048 + 10_240;
  const compressedBytes = expandedBytes + Math.ceil(expandedBytes / 1000) + 65_536;
  return { directories, members, contentBytes, expandedBytes, compressedBytes };
}

export async function fetchGitHubAsset({ signal, ...options }) {
  const { maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new WorkerError('artifact_archive_size_mismatch');
  const deadline = AbortSignal.timeout(600_000);
  signal?.throwIfAborted();
  await downloadGitHubAssetAttempt({ ...options, signal, deadline });
}

async function downloadGitHubAssetAttempt({ github, asset, destination, signal, deadline, maxBytes }) {
  const controller = new AbortController();
  const combined = AbortSignal.any([controller.signal, deadline, ...(signal ? [signal] : [])]);
  const child = spawn('gh', ['release', 'download', github.tag, '--repo', github.repository,
    '--pattern', asset, '--output', '-'], { signal: combined, stdio: ['ignore', 'pipe', 'pipe'] });
  let stalled = false;
  let stallTimer;
  const receivedBytes = chunk => {
    if (chunk && chunk.length === 0) return;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, 60_000);
  };
  receivedBytes();
  child.stdout.on('data', receivedBytes);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1200); });
  const closed = new Promise(resolve => child.once('close', resolve));
  let launchError;
  const exited = new Promise((resolve, reject) => {
    child.once('error', error => {
      launchError = error;
      reject(new WorkerError('worker_update_github_unavailable', error.message));
    });
    child.once('close', code => code === 0 ? resolve() : reject(new WorkerError('worker_update_github_unavailable')));
  });
  const copied = pipeline(child.stdout, new ByteLimit(maxBytes, 'artifact_archive_size_mismatch'),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: combined });
  try {
    await Promise.all([copied, exited]);
    return true;
  } catch (error) {
    controller.abort();
    await Promise.allSettled([copied, exited, closed]);
    await rm(destination, { force: true });
    signal?.throwIfAborted();
    if (error instanceof WorkerError && error.code !== 'worker_update_github_unavailable') throw error;
    const reason = stalled ? 'GitHub download stalled: no bytes received for 60000 ms.' : error.message;
    const detail = stalled && stderr.trim() ? `${reason} ${stderr.trim()}` : stderr.trim() || reason;
    const rateLimited = /rate limit|abuse detection/i.test(detail);
    const denied = /HTTP (?:401|403)\b|gh auth login|bad credentials|authentication (?:required|failed)|permission denied/i
      .test(detail);
    const permanent = ['ENOENT', 'EACCES'].includes(launchError?.code) || child.exitCode === 4
      || denied && !rateLimited;
    const code = permanent ? 'worker_update_github_configuration' : 'worker_update_github_unavailable';
    throw new WorkerError(code, `${code}: ${detail}`, { cause: error });
  } finally {
    clearTimeout(stallTimer);
    child.stdout.removeListener('data', receivedBytes);
  }
}

function archiveReader(stream) {
  const iterator = stream[Symbol.asyncIterator]();
  let chunk = Buffer.alloc(0);
  let offset = 0;
  return {
    async read(size) {
      const result = Buffer.alloc(size);
      let written = 0;
      while (written < size) {
        if (offset === chunk.length) {
          const next = await iterator.next();
          if (next.done) throw new WorkerError('artifact_archive_invalid');
          chunk = next.value;
          offset = 0;
        }
        const length = Math.min(size - written, chunk.length - offset);
        chunk.copy(result, written, offset, offset + length);
        written += length;
        offset += length;
      }
      return result;
    },
    async finish() {
      if (chunk.subarray(offset).some(byte => byte !== 0)) throw new WorkerError('artifact_archive_invalid');
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        if (next.value.some(byte => byte !== 0)) throw new WorkerError('artifact_archive_invalid');
      }
    },
  };
}

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(value)) throw new WorkerError('artifact_archive_invalid');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new WorkerError('artifact_archive_invalid');
  return number;
}

function tarHeader(bytes) {
  const checksum = bytes.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (checksum !== octal(bytes.subarray(148, 156))) throw new WorkerError('artifact_archive_invalid');
  const text = (start, end) => bytes.subarray(start, end).toString('utf8').replace(/\0.*$/u, '');
  const prefix = text(345, 500);
  const name = text(0, 100);
  const ustar = text(257, 263) === 'ustar';
  return { path: ustar && prefix ? `${prefix}/${name}` : name,
    size: octal(bytes.subarray(124, 136)), type: text(156, 157) || '0' };
}

function memberPath(path, type) {
  const withoutPrefix = path.startsWith('./') ? path.slice(2) : path;
  const value = type === '5' ? withoutPrefix.replace(/\/$/u, '') : withoutPrefix;
  if (type === '5' && value === '') return value;
  if (!/^[a-zA-Z0-9_@./-]+$/u.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new WorkerError('artifact_archive_invalid');
  }
  return value;
}

async function readMember(reader, member, directory, file) {
  if (member.size > file.size) throw new WorkerError('artifact_file_size_mismatch');
  if (file.path !== 'manifest.json' && member.size !== file.size) {
    throw new WorkerError('artifact_file_size_mismatch');
  }
  const path = join(directory, file.path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  const digest = createHash('sha256');
  const manifest = [];
  try {
    let remaining = member.size;
    while (remaining > 0) {
      const bytes = await reader.read(Math.min(remaining, 65_536));
      digest.update(bytes);
      await handle.writeFile(bytes);
      if (file.path === 'manifest.json') manifest.push(bytes);
      remaining -= bytes.length;
    }
  } finally {
    await handle.close();
  }
  if (digest.digest('hex') !== file.sha256) {
    throw new WorkerError(file.path === 'manifest.json' ? 'manifest_checksum_mismatch' : 'artifact_checksum_mismatch');
  }
  return Buffer.concat(manifest);
}

async function extractMembers(reader, { announced, release, directory, limits }) {
  const expected = new Map(announced.files.map(file => [file.path, file]));
  expected.set('manifest.json', { path: 'manifest.json', size: WORKER_UPDATE_MAX_JSON_BYTES,
    sha256: release.manifestSha256 });
  const seen = new Set();
  let manifest;
  let longName;
  let entries = 0;
  for (;;) {
    const header = await reader.read(512);
    if (header.every(byte => byte === 0)) {
      if (longName || !(await reader.read(512)).every(byte => byte === 0)) {
        throw new WorkerError('artifact_archive_invalid');
      }
      await reader.finish();
      break;
    }
    if (++entries > limits.members * 2) throw new WorkerError('artifact_archive_invalid');
    const member = tarHeader(header);
    if (member.type === 'L') {
      if (longName || member.size > 1025 || member.size === 0) throw new WorkerError('artifact_archive_invalid');
      const bytes = await reader.read(member.size);
      longName = bytes.toString('utf8').replace(/\0$/u, '');
      const path = memberPath(longName, longName.endsWith('/') ? '5' : '0');
      if (!expected.has(path) && !limits.directories.has(path)) throw new WorkerError('artifact_archive_invalid');
    } else {
      const path = memberPath(longName ?? member.path, member.type);
      longName = undefined;
      if (seen.has(path)) throw new WorkerError('artifact_archive_invalid');
      seen.add(path);
      if (member.type === '5') {
        if (!limits.directories.has(path) || member.size !== 0) throw new WorkerError('artifact_archive_invalid');
      } else {
        const file = expected.get(path);
        if (member.type !== '0' || !file) throw new WorkerError('artifact_archive_invalid');
        const bytes = await readMember(reader, member, directory, file);
        if (path === 'manifest.json') {
          manifest = WorkerArtifactManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
          if (!isDeepStrictEqual(manifest, announced)) throw new WorkerError('manifest_metadata_mismatch');
        }
      }
    }
    await reader.read((512 - member.size % 512) % 512);
  }
  if (!manifest || [...expected.keys()].some(path => !seen.has(path))) throw new WorkerError('artifact_archive_invalid');
  return manifest;
}

export async function extractWorkerArchive(options) {
  const { archive, limits, signal } = options;
  const info = await lstat(archive);
  if (!info.isFile() || info.size > limits.compressedBytes) throw new WorkerError('artifact_archive_size_mismatch');
  const source = createReadStream(archive);
  const expanded = new ByteLimit(limits.expandedBytes, 'artifact_archive_size_mismatch');
  const pumping = pipeline(source, createGunzip(), expanded, { signal });
  // The iterator reports stream errors; retain the pump for joined cleanup too.
  void pumping.catch(error => expanded.destroy(error));
  try {
    const result = await extractMembers(archiveReader(expanded), options);
    await pumping;
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('artifact_archive_invalid', undefined, { cause: error });
  } finally {
    source.destroy();
    expanded.destroy();
    await Promise.allSettled([pumping]);
  }
}

export async function requireArchiveCapacity(directory, limits) {
  const storage = await statfs(directory);
  if (storage.bavail * storage.bsize < limits.compressedBytes + limits.contentBytes + WORKER_UPDATE_MAX_JSON_BYTES) {
    throw new WorkerError('artifact_staging_space_unavailable');
  }
}
