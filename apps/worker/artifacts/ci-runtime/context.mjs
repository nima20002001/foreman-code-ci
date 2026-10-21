import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { parse } from 'yaml';
import { readSeedFile, readSeedFileEntry, validateSeedReceipt, verifySeedFiles } from './seed-policy.mjs';

export const parseCiLock = text => parse(text);

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

const modulePath = fileURLToPath(import.meta.url);
const bundled = basename(modulePath) !== 'context.mjs';
const controls = bundled ? join(dirname(modulePath), '../artifacts/ci-runtime') : dirname(modulePath);
const scripts = bundled ? join(dirname(modulePath), '../artifacts/verification')
  : join(dirname(modulePath), '../../../../scripts');

async function installedRuntimeFiles(offlineSeed) {
  const controlNames = ['Containerfile', 'corepack'];
  if (offlineSeed) controlNames.push('seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs');
  const entries = controlNames.map(name => ({ root: controls, name, destination: name }));
  for (const name of ['verification-runner.mjs', 'verify-repository.mjs', 'verification-reports.mjs', 'integration-process.mjs', 'integration-capabilities.mjs']) {
    entries.push({ root: scripts, name, destination: `verification/${name}` });
  }
  for (const path of ['apps/worker/src/diagnostics.mjs', 'packages/contracts/src/verificationEnvironment.mjs',
    'packages/contracts/src/integrationScheduling.mjs']) {
    entries.push({ root: join(scripts, '..', dirname(path)), name: basename(path), destination: path });
  }
  return Promise.all(entries.map(async entry => ({ ...entry,
    bytes: await readSeedFile(entry.root, entry.name, 1024 * 1024) })));
}

async function committedDependencies(repository, commit) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', args, { cwd: repository, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const captured = git('rev-parse', `${commit}^{commit}`).toString().trim();
  const tree = git('ls-tree', '-rz', '--full-tree', captured).toString().split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' '), path = line.slice(tab + 1);
    return { mode, type, blob, path };
  });
  const paths = tree.filter(entry => ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(entry.path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(entry.path));
  if (!paths.some(entry => entry.path === 'pnpm-lock.yaml') || !paths.some(entry => entry.path === 'pnpm-workspace.yaml')) throw new Error('Committed CI lockfile and workspace policy required');
  const entries = paths;
  if (entries.some(entry => !entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
    || entry.path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('CI context requires regular committed inputs');
  const snapshots = new Map(entries.map(entry => [entry.path, { ...entry, bytes: git('show', `${captured}:${entry.path}`) }]));
  return { captured, paths, snapshots };
}

export async function ciRuntimeInputDigest({ repository, commit }) {
  const { snapshots } = await committedDependencies(repository, commit);
  const runtimeFiles = await installedRuntimeFiles(true);
  const builder = await readSeedFile(controls, 'context.mjs', 1024 * 1024);
  return hash(JSON.stringify({ platform: process.platform, architecture: process.arch, builder: hash(builder),
    dependencies: [...snapshots].map(([path, entry]) => [path, hash(entry.bytes)]),
    controls: runtimeFiles.map(entry => [entry.destination, hash(entry.bytes)]),
  }));
}

export async function buildCiRuntimeContext({ repository, commit = 'HEAD', output, offlineSeed }) {
  const { captured, paths, snapshots } = await committedDependencies(repository, commit);
  const runtimeFiles = await installedRuntimeFiles(offlineSeed);
  let seed;
  let seedUsage;
  if (offlineSeed) {
    const receiptFile = await open(offlineSeed.receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await receiptFile.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.mode & 0o077
        || info.size > 16 * 1024 * 1024) throw new Error('Private reviewed seed receipt required.');
      seed = JSON.parse((await readSeedFile(dirname(offlineSeed.receiptPath),
        offlineSeed.receiptPath.slice(dirname(offlineSeed.receiptPath).length + 1), info.size)).toString('utf8'));
    } finally { await receiptFile.close(); }
    const lock = parse(snapshots.get('pnpm-lock.yaml').bytes.toString('utf8'));
    const policy = parse(snapshots.get('pnpm-workspace.yaml').bytes.toString('utf8'));
    const manifest = JSON.parse(snapshots.get('package.json').bytes.toString('utf8'));
    if (manifest.packageManager !== 'pnpm@11.27.0' || policy.minimumReleaseAge !== 2880
      || policy.minimumReleaseAgeStrict !== true || policy.minimumReleaseAgeIgnoreMissingTime !== false
      || policy.minimumReleaseAgeExclude?.length) throw new Error('Committed strict 48-hour package policy required.');
    const packages = Object.entries(lock.packages ?? {}).map(([key, pkg]) => {
      const separator = key.lastIndexOf('@');
      if (separator < 1 || !pkg.resolution?.integrity) throw new Error('Locked registry package release evidence required.');
      return { name: key.slice(0, separator), version: key.slice(separator + 1), integrity: pkg.resolution.integrity };
    });
    const dependencyInputs = paths.map(entry => ({ path: entry.path, sha256: hash(snapshots.get(entry.path).bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path));
    validateSeedReceipt(seed, { dependencyInputs, packages, platform: { os: 'linux', arch: 'x64', libc: 'glibc' } });
    seedUsage = await verifySeedFiles(offlineSeed.directory, seed);
  }
  let unitCodex;
  if (offlineSeed?.unitCodex) {
    const tool = offlineSeed.unitCodex;
    if (!tool.review?.reviewedByPrincipalId || !/^[a-f0-9]{64}$/.test(tool.review.decisionDigest)
      || !Number.isFinite(Date.parse(tool.review.reviewedAt)) || Date.parse(tool.review.reviewedAt) > Date.now()
      || !/^[a-f0-9]{64}$/.test(tool.binarySha256) || !tool.version || !tool.path?.startsWith('/')) {
      throw new Error('Reviewed Codex schema binary receipt required.');
    }
    const bytes = await readSeedFile(dirname(tool.path), tool.path.slice(dirname(tool.path).length + 1), 256 * 1024 * 1024);
    if (hash(bytes) !== tool.binarySha256) throw new Error('Reviewed Codex schema binary changed.');
    unitCodex = { tool, bytes };
  }
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'tools'), { mode: 0o755 });
  if (unitCodex) await writeFile(join(output, 'tools/codex'), unitCodex.bytes, { mode: 0o755, flag: 'wx' });
  for (const entry of paths) {
    const destination = join(output, 'source-lock', entry.path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, snapshots.get(entry.path).bytes, { mode: 0o644, flag: 'wx' });
  }
  await mkdir(join(output, 'verification'), { mode: 0o755 });
  for (const { destination, bytes } of runtimeFiles) {
    await mkdir(dirname(join(output, destination)), { recursive: true, mode: 0o755 });
    await writeFile(join(output, destination), bytes, { mode: destination === 'corepack' ? 0o755 : 0o644, flag: 'wx' });
  }
  const receipt = { sourceCommit: captured,
    files: [...snapshots.values()].map(({ path, blob, bytes }) => ({ path, gitBlobSha1: blob, sha256: hash(bytes) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    runtimeFiles: runtimeFiles.map(({ destination, bytes }) => ({ path: destination, sha256: hash(bytes) })),
  };
  if (seed) {
    for (const file of seed.files) {
      const { bytes, executable } = await readSeedFileEntry(offlineSeed.directory, file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('Reviewed offline seed changed during copy.');
      const destination = join(output, 'seed', file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await writeFile(destination, bytes, { mode: executable ? 0o755 : 0o644, flag: 'wx' });
    }
    const seedBytes = Buffer.from(`${JSON.stringify(seed)}\n`);
    await writeFile(join(output, 'seed-receipt.json'), seedBytes, { mode: 0o644, flag: 'wx' });
    receipt.offlineSeed = { receiptSha256: hash(seedBytes), ...seedUsage, platform: seed.platform,
      packageManager: seed.packageManager, provenanceDigest: seed.provenanceDigest,
      releaseAge: { minimumMinutes: 2880, strict: true, rejectMissingTime: true, packages: seed.packages.length } };
  }
  if (unitCodex) receipt.unitCodex = { version: unitCodex.tool.version, binarySha256: unitCodex.tool.binarySha256,
    executable: '/opt/graphql-ci/tools/codex', review: unitCodex.tool.review };
  await writeFile(join(output, 'context-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return receipt;
}
