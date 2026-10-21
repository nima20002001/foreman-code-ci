import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_MANAGER = 'pnpm@11.27.0';
export const RELEASE_AGE_MINUTES = 2880;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safePath = value => typeof value === 'string' && !value.includes('\\') && !value.includes('\0')
  && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..');

export async function readSeedFile(root, path, maximum) {
  return (await readSeedFileEntry(root, path, maximum)).bytes;
}

export async function readSeedFileEntry(root, path, maximum) {
  if (!safePath(path)) throw new Error('Unsafe seed file path.');
  const handles = [];
  try {
    let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
      parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(parent);
    }
    const file = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new Error('Seed file type or budget rejected.');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) throw new Error('Seed file changed during capture.');
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (bytes.length !== before.size || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Seed file changed during capture.');
    }
    return { bytes, executable: Boolean(before.mode & 0o111) };
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

/** Installer receipt: trust comes from its protected, reviewed caller and registry capture, never a Job input. */
export function validateSeedReceipt(receipt, { dependencyInputs, packages, platform, now = Date.now() }) {
  if (receipt?.schemaVersion !== 1 || receipt.packageManager !== PACKAGE_MANAGER
    || receipt.minimumReleaseAge !== RELEASE_AGE_MINUTES || receipt.minimumReleaseAgeStrict !== true
    || receipt.minimumReleaseAgeIgnoreMissingTime !== false
    || !['os', 'arch', 'libc'].every(key => receipt.platform?.[key] === platform[key])
    || !receipt.review?.reviewedByPrincipalId || !digest(receipt.review.decisionDigest)
    || !Number.isFinite(Date.parse(receipt.review.reviewedAt)) || Date.parse(receipt.review.reviewedAt) > now
    || !digest(receipt.provenanceDigest) || !Number.isFinite(Date.parse(receipt.capturedAt))
    || Date.parse(receipt.capturedAt) > Date.parse(receipt.review.reviewedAt)
    || !Array.isArray(receipt.files) || !Array.isArray(receipt.packages)
    || !Number.isSafeInteger(receipt.maxBytes) || receipt.maxBytes <= 0
    || !Number.isSafeInteger(receipt.maxInodes) || receipt.maxInodes <= 0) {
    throw new Error('Reviewed offline dependency seed required.');
  }
  if (JSON.stringify(receipt.dependencyInputs) !== JSON.stringify(dependencyInputs)) {
    throw new Error('Dependency seed belongs to another committed lockfile, policy or manifest set.');
  }
  const names = new Set();
  let bytes = 0;
  for (const file of receipt.files) {
    if (!safePath(file.path) || !/^(?:corepack-cache|pnpm-store|registry-cache|metadata)\//.test(file.path)
      || names.has(file.path) || !digest(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error('Exact regular offline seed inventory required.');
    }
    names.add(file.path);
    bytes += file.bytes;
  }
  if (!Number.isSafeInteger(bytes) || bytes > receipt.maxBytes || names.size > receipt.maxInodes
    || !['corepack-cache', 'pnpm-store', 'registry-cache'].every(root => receipt.files.some(file => file.path.startsWith(`${root}/`)))) {
    throw new Error('Offline dependency seed exceeds its reviewed budget or lacks a required store.');
  }
  const locked = new Map(packages.map(pkg => [`${pkg.name}@${pkg.version}`, pkg]));
  if (locked.size !== packages.length || receipt.packages.length !== locked.size) {
    throw new Error('Release-age evidence must cover every locked package.');
  }
  const observed = new Set();
  for (const pkg of receipt.packages) {
    const key = `${pkg.name}@${pkg.version}`;
    const expected = locked.get(key);
    const released = Date.parse(pkg.publishedAt);
    if (!expected || observed.has(key) || expected.integrity !== pkg.integrity
      || !Number.isFinite(released) || Date.parse(receipt.capturedAt) - released < RELEASE_AGE_MINUTES * 60_000
      || !safePath(pkg.metadataPath) || !pkg.metadataPath.startsWith('metadata/') || !names.has(pkg.metadataPath)) {
      throw new Error('Missing, immature or inconsistent locked release-age evidence.');
    }
    observed.add(key);
  }
  return receipt;
}

export async function verifySeedFiles(root, receipt) {
  if (await realpath(root) !== root) throw new Error('Canonical offline seed root required.');
  const expected = new Map(receipt.files.map(file => [file.path, file]));
  let inodes = 0;
  const walk = async (directory, prefix = '') => {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const entry of await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (++inodes > receipt.maxInodes) throw new Error('Offline seed inode budget exceeded.');
        if (entry.isDirectory()) await walk(`/proc/self/fd/${handle.fd}/${entry.name}`, path);
        else if (!entry.isFile() || !expected.has(path)) throw new Error('Undeclared or nonregular offline seed entry.');
      }
    } finally { await handle.close(); }
  };
  await walk(root);
  for (const file of receipt.files) {
    const bytes = await readSeedFile(root, file.path, file.bytes);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error('Offline seed integrity changed.');
  }
  for (const pkg of receipt.packages) {
    const file = expected.get(pkg.metadataPath);
    const metadata = JSON.parse((await readSeedFile(root, pkg.metadataPath, file.bytes)).toString('utf8'));
    if (metadata.name !== pkg.name || metadata.time?.[pkg.version] !== pkg.publishedAt
      || metadata.versions?.[pkg.version]?.dist?.integrity !== pkg.integrity) {
      throw new Error('Registry capture does not prove the locked package release.');
    }
  }
  return { bytes: receipt.files.reduce((total, file) => total + file.bytes, 0), inodes };
}

// Bundled into the worker CLI, import.meta.url names that CLI; only run as this script.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && basename(self) === 'seed-policy.mjs' && resolve(process.argv[1]) === self) {
  const [root, receiptPath] = process.argv.slice(2);
  if (!root || !receiptPath) throw new Error('Usage: seed-policy.mjs /seed /receipt.json');
  const file = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let receipt;
  try { receipt = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
  validateSeedReceipt(receipt, {
    dependencyInputs: receipt.dependencyInputs,
    packages: receipt.packages,
    platform: { os: process.platform, arch: process.arch, libc: 'glibc' },
  });
  await verifySeedFiles(root, receipt);
}
