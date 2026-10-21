import { homedir } from 'node:os';
const fixtureGitEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir, rm, chmod, symlink, link, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildCiRuntimeContext } from '../../../scripts/build-ci-runtime-context.mjs';
import { acquireWorkerLock } from '../src/runtime.mjs';
import { validateSeedReceipt, verifySeedFiles } from '../artifacts/ci-runtime/seed-policy.mjs';
import { assertEffectivePackagePolicy, assertEffectiveVerificationStore, assertVerificationPackageArguments,
  needsTestDatabase, verificationEnvironment, verificationInstallArguments }
  from '../artifacts/ci-runtime/verification-policy.mjs';
import { copyVerificationSeed, prepareVerificationWorkspace } from '../artifacts/ci-runtime/verification-policy.mjs';

const artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function offlineSeedFixture(t) {
  const directory = await realpath(await mkdtemp(join(persistentFixtureRoot, 'verification-seed-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const metadata = { name: 'fixture', time: { '1.0.0': '2026-09-30T00:00:00Z' },
    versions: { '1.0.0': { dist: { integrity: 'sha512-fixture' } } } };
  const contents = new Map([
    ['corepack-cache/pnpm/version.json', Buffer.from('{}')], ['pnpm-store/index.db', Buffer.from('closed store')],
    ['registry-cache/fixture.json', Buffer.from(JSON.stringify(metadata))],
    ['metadata/fixture.json', Buffer.from(JSON.stringify(metadata))],
  ]);
  for (const [path, bytes] of contents) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    await writeFile(join(directory, path), bytes);
  }
  const packageEvidence = { name: 'fixture', version: '1.0.0', integrity: 'sha512-fixture',
    publishedAt: metadata.time['1.0.0'], metadataPath: 'metadata/fixture.json' };
  const receipt = {
    schemaVersion: 1, packageManager: 'pnpm@11.27.0', platform: { os: 'linux', arch: 'x64', libc: 'glibc' },
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false,
    capturedAt: '2026-10-02T00:00:00Z', provenanceDigest: 'a'.repeat(64),
    review: { reviewedByPrincipalId: 'owner', reviewedAt: '2026-10-02T01:00:00Z', decisionDigest: 'b'.repeat(64) },
    maxBytes: 4096, maxInodes: 32, dependencyInputs: [{ path: 'pnpm-lock.yaml', sha256: 'c'.repeat(64) }],
    files: [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
    packages: [packageEvidence],
  };
  const options = { dependencyInputs: receipt.dependencyInputs, packages: [packageEvidence], platform: receipt.platform,
    now: Date.parse('2026-10-03T00:00:00Z') };
  return { directory, receipt, options };
}

test('offline preparation copies a fresh private store and cache before retaining its seed marker', async t => {
  const f = await offlineSeedFixture(t);
  const scratch = join(f.directory, 'job-scratch');
  const receipt = Buffer.from(JSON.stringify(f.receipt));
  await copyVerificationSeed(f.directory, scratch, receipt);
  assert.equal(await readFile(join(scratch, 'pnpm-store/index.db'), 'utf8'), 'closed store');
  assert.deepEqual(await readFile(join(scratch, 'cache/pnpm/fixture.json')),
    await readFile(join(f.directory, 'registry-cache/fixture.json')));
  assert.equal(await readFile(join(scratch, 'seed-receipt.sha256'), 'utf8'), hash(receipt));
  await copyVerificationSeed(f.directory, scratch, receipt);
  await assert.rejects(copyVerificationSeed(f.directory, scratch, Buffer.from('another receipt')), /another approved seed/);
});

test('read-only package policy queries do not copy dependencies but install still creates its private cold store', async t => {
  const f = await offlineSeedFixture(t);
  const scratch = join(f.directory, 'query-scratch');
  const receipt = Buffer.from(JSON.stringify(f.receipt));
  for (const args of [['config', 'get', 'minimumReleaseAge'], ['config', 'list', '--json']]) {
    await prepareVerificationWorkspace(args, f.directory, scratch, receipt);
  }
  await assert.rejects(stat(join(scratch, 'pnpm-store')), { code: 'ENOENT' });
  await assert.rejects(stat(join(scratch, 'seed-receipt.sha256')), { code: 'ENOENT' });
  await prepareVerificationWorkspace(['install', '--frozen-lockfile'], f.directory, scratch, receipt);
  assert.equal(await readFile(join(scratch, 'pnpm-store/index.db'), 'utf8'), 'closed store');
  assert.equal(await readFile(join(scratch, 'seed-receipt.sha256'), 'utf8'), hash(receipt));
});

test('offline seeding accepts runner-created empty private directories and refuses populated or linked destinations', async t => {
  const f = await offlineSeedFixture(t);
  const receipt = Buffer.from(JSON.stringify(f.receipt));
  const scratch = join(f.directory, 'runner-scratch');
  for (const name of ['pnpm-store', 'cache/pnpm']) await mkdir(join(scratch, name), { recursive: true, mode: 0o700 });
  await copyVerificationSeed(f.directory, scratch, receipt);
  assert.equal(await readFile(join(scratch, 'pnpm-store/index.db'), 'utf8'), 'closed store');
  const occupied = join(f.directory, 'occupied-scratch');
  await mkdir(join(occupied, 'pnpm-store'), { recursive: true, mode: 0o700 });
  await writeFile(join(occupied, 'pnpm-store/original'), 'retained original');
  await assert.rejects(copyVerificationSeed(f.directory, occupied, receipt));
  assert.equal(await readFile(join(occupied, 'pnpm-store/original'), 'utf8'), 'retained original');
  const linked = join(f.directory, 'linked-scratch');
  await mkdir(linked, { mode: 0o700 });
  await symlink(join(scratch, 'pnpm-store'), join(linked, 'pnpm-store'));
  await assert.rejects(copyVerificationSeed(f.directory, linked, receipt));
});

test('offline seed validates every locked release at the strict 48-hour boundary and verifies captured bytes', async t => {
  const f = await offlineSeedFixture(t);
  assert.equal(validateSeedReceipt(f.receipt, f.options), f.receipt);
  const measured = await verifySeedFiles(f.directory, f.receipt);
  assert.equal(measured.bytes, f.receipt.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.ok(measured.inodes > f.receipt.files.length);
  for (const change of [
    receipt => { receipt.packages[0].publishedAt = '2026-09-30T00:00:01Z'; },
    receipt => { receipt.packages[0].publishedAt = null; },
    receipt => { receipt.review = null; },
    receipt => { receipt.minimumReleaseAgeIgnoreMissingTime = true; },
    receipt => { receipt.packages = []; },
    receipt => { receipt.dependencyInputs[0].sha256 = 'd'.repeat(64); },
  ]) {
    const receipt = structuredClone(f.receipt);
    change(receipt);
    assert.throws(() => validateSeedReceipt(receipt, f.options));
  }
  await writeFile(join(f.directory, 'pnpm-store/index.db'), 'changed');
  await assert.rejects(verifySeedFiles(f.directory, f.receipt), /integrity/);
});

test('offline seed requires a canonical root when its parent is a symlink', async t => {
  const f = await offlineSeedFixture(t);
  const parent = await mkdtemp(join(persistentFixtureRoot, 'verification-seed-parent-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const alias = join(parent, 'linked-parent');
  await symlink(dirname(f.directory), alias);
  const seedRoot = join(alias, basename(f.directory));
  await assert.rejects(verifySeedFiles(seedRoot, f.receipt), /Canonical offline seed root required/);
  const measured = await verifySeedFiles(await realpath(seedRoot), f.receipt);
  assert.equal(measured.bytes, f.receipt.files.reduce((sum, file) => sum + file.bytes, 0));
});

test('offline seed rejects links, undeclared files, missing registry times and quota pressure', async t => {
  for (const kind of ['symlink', 'hardlink', 'extra', 'missing-time', 'bytes', 'inodes']) await t.test(kind, async child => {
    const f = await offlineSeedFixture(child);
    if (kind === 'symlink') {
      await rm(join(f.directory, 'pnpm-store/index.db'));
      await symlink('/etc/passwd', join(f.directory, 'pnpm-store/index.db'));
    }
    if (kind === 'hardlink') {
      const outside = await mkdtemp(join(persistentFixtureRoot, 'seed-link-'));
      child.after(() => rm(outside, { recursive: true, force: true }));
      await link(join(f.directory, 'pnpm-store/index.db'), join(outside, 'alias'));
    }
    if (kind === 'extra') await writeFile(join(f.directory, 'registry-cache/unknown'), 'extra');
    if (kind === 'missing-time') {
      const path = 'metadata/fixture.json';
      const metadata = JSON.parse(await readFile(join(f.directory, path), 'utf8'));
      delete metadata.time;
      const bytes = Buffer.from(JSON.stringify(metadata));
      await writeFile(join(f.directory, path), bytes);
      Object.assign(f.receipt.files.find(file => file.path === path), { bytes: bytes.length, sha256: hash(bytes) });
    }
    if (kind === 'bytes') f.receipt.maxBytes = 1;
    if (kind === 'inodes') f.receipt.maxInodes = f.receipt.files.length;
    await assert.rejects(async () => {
      validateSeedReceipt(f.receipt, f.options);
      await verifySeedFiles(f.directory, f.receipt);
    });
  });
});

test('verification context binds reviewed seed provenance to committed dependency inputs and rejects a changed lock', async t => {
  const f = await offlineSeedFixture(t);
  const executablePath = 'pnpm-store/native-compiler-exec';
  const executable = Buffer.from('#!/bin/sh\nprintf "native compiler runs\\n"\n');
  await writeFile(join(f.directory, executablePath), executable, { mode: 0o700, flag: 'wx' });
  f.receipt.files.push({ path: executablePath, bytes: executable.length, sha256: hash(executable) });
  t.mock.method(Date, 'now', () => f.options.now);
  const repository = join(f.directory, 'repository');
  await mkdir(repository);
  const git = (...args) => execFileSync('git', args, { cwd: repository, env: fixtureGitEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  const manifests = new Map([
    ['package.json', '{"packageManager":"pnpm@11.27.0"}'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9\npackages:\n  fixture@1.0.0:\n    resolution:\n      integrity: sha512-fixture\n'],
    ['pnpm-workspace.yaml', 'minimumReleaseAge: 2880\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n'],
  ]);
  for (const [path, bytes] of manifests) await writeFile(join(repository, path), bytes);
  const controls = join(repository, 'apps/worker/artifacts/ci-runtime');
  await mkdir(controls, { recursive: true });
  for (const name of ['Containerfile', 'corepack', 'seed-policy.mjs', 'verification-policy.mjs', 'verification-observation.mjs']) {
    await writeFile(join(controls, name), await readFile(new URL(`../artifacts/ci-runtime/${name}`, import.meta.url)));
  }
  git('add', '.');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  f.receipt.dependencyInputs = [...manifests].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const receiptPath = join(f.directory, 'reviewed.json');
  const seedRoot = join(f.directory, 'seed');
  await mkdir(seedRoot);
  for (const root of ['corepack-cache', 'pnpm-store', 'registry-cache', 'metadata']) {
    await rename(join(f.directory, root), join(seedRoot, root));
  }
  await writeFile(receiptPath, JSON.stringify(f.receipt), { mode: 0o600 });
  const output = join(f.directory, 'context');
  const binaryPath = join(f.directory, 'reviewed-codex');
  const binary = Buffer.from('reviewed schema-only binary input');
  await writeFile(binaryPath, binary, { mode: 0o700 });
  const unitCodex = { path: binaryPath, version: 'schema-fixture', binarySha256: hash(binary),
    review: { reviewedByPrincipalId: 'owner', decisionDigest: 'b'.repeat(64), reviewedAt: '2026-10-02T01:00:00Z' } };
  const receipt = await buildCiRuntimeContext({ repository, output,
    offlineSeed: { directory: seedRoot, receiptPath, unitCodex } });
  assert.equal(execFileSync(join(output, 'seed', executablePath), { encoding: 'utf8' }), 'native compiler runs\n');
  assert.equal(spawnSync(join(output, 'seed/pnpm-store/index.db')).error?.code, 'EACCES');
  const observation = await import(pathToFileURL(join(output, 'verification-observation.mjs')).href);
  assert.equal(await observation.probeExecutableScratch(f.directory), 0);
  assert.ok(!(await readdir(f.directory)).some(name => name.startsWith('qualification-')));
  assert.deepEqual(await readFile(join(output, 'tools/codex')), binary);
  assert.deepEqual(receipt.unitCodex, { executable: '/opt/graphql-ci/tools/codex',
    version: unitCodex.version, binarySha256: unitCodex.binarySha256, review: unitCodex.review });
  await writeFile(binaryPath, 'changed reviewed binary');
  await assert.rejects(buildCiRuntimeContext({ repository, output: join(f.directory, 'changed-tool'),
    offlineSeed: { directory: seedRoot, receiptPath, unitCodex } }), /binary changed/);
  assert.equal(receipt.sourceCommit, git('rev-parse', 'HEAD'));
  assert.deepEqual(receipt.offlineSeed.releaseAge, { minimumMinutes: 2880, strict: true, rejectMissingTime: true, packages: 1 });
  assert.equal(receipt.offlineSeed.provenanceDigest, f.receipt.provenanceDigest);
  assert.equal(await readFile(join(output, 'seed/pnpm-store/index.db'), 'utf8'), 'closed store');
  await writeFile(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\npackages: {}\n');
  git('add', 'pnpm-lock.yaml');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'changed dependencies');
  await assert.rejects(buildCiRuntimeContext({ repository, output: join(f.directory, 'changed-context'),
    offlineSeed: { directory: seedRoot, receiptPath } }), /another committed/);
});

test('verification installer fixes offline frozen dev installs, isolates caches and denies policy relaxation', () => {
  assert.deepEqual(verificationInstallArguments(['install', '--frozen-lockfile']),
    ['install', '--frozen-lockfile', '--offline', '--prod=false']);
  assert.deepEqual(verificationInstallArguments(['install', '--frozen-lockfile', '--offline', '--prod=false',
    '--store-dir', '/job-scratch/pnpm-store']), ['install', '--frozen-lockfile', '--offline', '--prod=false']);
  assert.throws(() => verificationInstallArguments(['install', '--store-dir', '/owner/store']));
  for (const argument of ['--no-frozen-lockfile', '--offline=false', '--prod', '--minimum-release-age=0']) {
    assert.throws(() => verificationInstallArguments(['install', argument]));
  }
  const environment = verificationEnvironment({ HOME: '/owner', npm_config_minimum_release_age: '0',
    NPM_CONFIG_USERCONFIG: '/owner/.npmrc', COREPACK_HOME: '/owner/cache', NODE_OPTIONS: '--import=/owner/hook',
    FOREMAN_CODE_VERIFICATION_UNIT_WORKERS: '1' });
  assert.equal(environment.HOME, '/job-scratch/home');
  assert.equal(environment.PNPM_CONFIG_OFFLINE, 'true');
  assert.equal(environment.FOREMAN_CODE_VERIFICATION_UNIT_WORKERS, '1');
  assert.equal(environment.npm_config_minimum_release_age, undefined);
  assert.equal(environment.NODE_OPTIONS, '--max-old-space-size=1536');
  const policy = { minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false };
  assert.doesNotThrow(() => assertEffectivePackagePolicy(policy));
  for (const change of [{ minimumReleaseAge: 0 }, { minimumReleaseAgeStrict: false },
    { minimumReleaseAgeIgnoreMissingTime: true }, { minimumReleaseAgeExclude: ['*'] }]) {
    assert.throws(() => assertEffectivePackagePolicy({ ...policy, ...change }));
  }
  const store = { offline: true, verifyStoreIntegrity: true, workspaceConcurrency: 1,
    storeDir: '/job-scratch/pnpm-store', cacheDir: '/job-scratch/cache/pnpm' };
  assert.doesNotThrow(() => assertEffectiveVerificationStore(store));
  assert.throws(() => assertEffectiveVerificationStore({ ...store, offline: false }));
  assert.throws(() => assertEffectiveVerificationStore({ ...store, storeDir: '/owner/.pnpm-store' }));
  assert.throws(() => assertEffectiveVerificationStore({ ...store, workspaceConcurrency: 9 }));
});

test('verification allows production deployment while preserving package policy', () => {
  const args = ['--filter', '@foreman-code/api', 'deploy', '--prod', '--legacy', '/tmp/release'];
  assert.doesNotThrow(() => assertVerificationPackageArguments(args));
  assert.deepEqual(verificationInstallArguments(args), args);
  for (const override of ['--prod=true', '--offline=false', '--minimum-release-age=0',
    '--store-dir=/owner/store', '--config.minimumReleaseAge=0']) {
    assert.throws(() => assertVerificationPackageArguments([...args, override]));
  }
  assert.throws(() => assertVerificationPackageArguments(['run', 'build', '--prod']));
});

test('the pinned pnpm reads the enforced offline store and cache from its supported environment', async t => {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'pnpm-effective-policy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = verificationEnvironment({ ...process.env, PNPM_CONFIG_STORE_DIR: '/owner/store',
    PNPM_CONFIG_CACHE_DIR: '/owner/cache', PNPM_CONFIG_OFFLINE: 'false', PNPM_CONFIG_WORKSPACE_CONCURRENCY: '9',
    NODE_OPTIONS: '--require /owner/unreviewed-preload.mjs' });
  const heapBytes = Number(execFileSync(process.execPath, ['-e',
    'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))'],
  { env: environment, encoding: 'utf8', timeout: 5000 }));
  assert.ok(heapBytes >= 1536 * 2**20 && heapBytes < 2 * 2**30);
  const config = JSON.parse(execFileSync('corepack', ['pnpm', 'config', 'list', '--json'], {
    env: { ...environment, HOME: directory, TMPDIR: directory, COREPACK_HOME: process.env.COREPACK_HOME ?? join(
      process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'node', 'corepack') },
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  }));
  assertEffectiveVerificationStore(config);
  assert.equal(Number(config.workspaceConcurrency ?? config['workspace-concurrency']), 1);
  assertEffectivePackagePolicy(config);
});

test('compiler heap scales with the reserved memory while keeping space for other processes', () => {
  for (const memoryGiB of [2, 4]) {
    const memoryBytes = memoryGiB * 2**30;
    const environment = verificationEnvironment({ NODE_OPTIONS: '--require /unreviewed/preload.mjs' }, memoryBytes);
    const heapBytes = Number(execFileSync(process.execPath, ['-e',
      'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))'],
    { env: environment, encoding: 'utf8', timeout: 5000 }));
    assert.ok(heapBytes >= memoryBytes * 0.75 && heapBytes < memoryBytes * 0.9);
  }
  for (const memoryBytes of [0, NaN, Infinity, 'max']) {
    assert.throws(() => verificationEnvironment({}, memoryBytes), /finite kernel memory reservation/);
  }
});

async function fixture(t) {
  // Capture requires persistent storage with private ancestors, including HOME.
  const directory = await mkdtemp(join(persistentFixtureRoot, 'job-runtime-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = join(directory, 'state'), base = join(directory, 'projects'), runtime = join(directory, 'managed');
  for (const path of [state, base, runtime]) await mkdir(path, { mode: 0o700 });
  const policyId = randomUUID(), source = join(runtime, 'source-materializations', policyId);
  await mkdir(source, { recursive: true, mode: 0o700 });
  const worker = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const keys = generateKeyPairSync('ed25519');
  const identity = { formatVersion: 1, workerInstallationId: randomUUID(), keyRevision: 1,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyFingerprint: hash(keys.publicKey.export({ type: 'spki', format: 'der' })) };
  const pairing = { formatVersion: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: identity.workerInstallationId,
    keyRevision: 1, authorizationRevision: 3, endpoint: 'wss://fixture.invalid/device/connect', credential: 'a'.repeat(64),
    mainPublicKeyFingerprint: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' };
  const hostRef = { kind: 'device', mainId: pairing.mainId, deviceId: pairing.deviceId };
  const approved = await worker.qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef, applicationInstallationId: identity.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-write'] }], managedRuntimeRoot: runtime });
  const info = await stat(source, { bigint: true });
  const filesystem = { device: info.dev.toString(), inode: info.ino.toString(), mountId: approved.runtimeFilesystem.mountId };
  const registration = { workerInstallationId: identity.workerInstallationId, keyRevision: 1, authorizationRevision: 3 };
  const sourcePin = { approvedSourceId: randomUUID(), snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) };
  const root = { version: 1, source: sourcePin, selection: { hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId: pairing.mainId, deviceId: pairing.deviceId, workerInstallationId: identity.workerInstallationId,
      workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: source, filesystem,
      accessMode: 'exclusive-write', snapshotId: sourcePin.snapshotId, manifestDigest: sourcePin.manifestDigest },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', registration, attestationId: 'attestation', attestationDigest: 'd'.repeat(64), boundAt: '2026-10-01T00:00:00.000Z' };
  // Only file metadata is captured here; this does not qualify an ext4 workload volume.
  const backingFile = await realpath('/etc/machine-id');
  const backing = await stat(backingFile);
  assert.equal(backing.uid, 0);
  assert.equal(backing.mode & 0o222, 0);
  assert.equal(backing.nlink, 1);
  assert.ok(backing.isFile() && backing.blocks * 512 >= backing.size);
  const executable = await realpath('/usr/bin/true');
  const input = { schemaVersion: 1, target: { hostRef, registration, mainInstallationId: pairing.mainId }, root,
    runtimeExecutable: executable, ociExecutable: executable, findmntExecutable: executable, runtimeRoot: runtime, backingFile,
    controllerEnvironment: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: directory, LANG: 'C.UTF-8' }, imageDigest: `sha256:${'e'.repeat(64)}`, toolchainDigest: 'f'.repeat(64), diskBytes: backing.size };
  for (const [name, value] of [['identity.json', identity], ['pairing.json', pairing], ['approved-roots.json', approved],
    ['workflow-operations.json', { retainedOriginal: 'workflow' }], ['job-runtime-operations.json', { retainedOriginal: 'job' }]]) {
    await writeFile(join(state, name), JSON.stringify(value), { mode: 0o600 });
  }
  const inputPath = join(directory, 'input.json'); await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
  const originalFiles = Object.fromEntries(await Promise.all((await readdir(state)).map(async name => [name, hash(await readFile(join(state, name)))])));
  const run = (args = []) => spawnSync(process.execPath,
    ['--disable-warning=ExperimentalWarning', join(artifact, 'src/cli.mjs'), 'capture-job-runtime', '--state', state, '--input', inputPath, ...args],
    { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: directory, LANG: 'C.UTF-8' } });
  const unchanged = async () => {
    for (const [name, digest] of Object.entries(originalFiles)) assert.equal(hash(await readFile(join(state, name))), digest, name);
    assert.ok(!(await readdir(state)).some(name => name.startsWith('.job-runtime-')));
  };
  return { state, directory, runtime, input, inputPath, worker, originalFiles, run, unchanged };
}

test('packaged capture uses the passive helper, publishes protected pins once and retains original identity/journals', { skip: !artifact }, async t => {
  const f = await fixture(t);
  assert.equal(typeof f.worker.captureInstalledRuntimeConfiguration, 'function');
  const unowned = join(f.directory, 'unowned-backing');
  await writeFile(unowned, Buffer.alloc(f.input.diskBytes), { mode: 0o400 });
  await assert.rejects(f.worker.captureInstalledRuntimeConfiguration({ ...f.input, backingFile: unowned }), /root-owned/);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { configurationPath: join(f.state, 'job-runtime.json'), captured: true, qualified: false, executionAuthorized: false });
  assert.equal(result.stderr, '');
  const path = join(f.state, 'job-runtime.json'), info = await stat(path), bytes = await readFile(path);
  assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, 0o600); assert.equal(info.nlink, 1); assert.ok(info.size <= 65536);
  const output = JSON.parse(bytes);
  assert.equal(output.pins.runtimeBinarySha256, hash(await readFile(f.input.runtimeExecutable)));
  assert.equal(output.pins.diskBytes, f.input.diskBytes);
  assert.equal(output.pins.bootId, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim());
  assert.match(output.pins.configurationDigest, /^[a-f0-9]{64}$/);
  for (const field of ['ready', 'measurement', 'qualified', 'credential']) assert.equal(field in output, false);
  assert.ok(!result.stdout.includes('a'.repeat(64)));
  const repeat = f.run();
  assert.equal(repeat.status, 1); assert.equal(repeat.stderr.trim(), 'job_runtime_configuration_exists');
  assert.equal(hash(await readFile(path)), hash(bytes)); await f.unchanged();
});

test('reviewed refresh preserves the previous configuration and rejects stale digests or unfinished work', { skip: !artifact }, async t => {
  for (const kind of ['refresh', 'stale-digest', 'unfinished-work', 'active-worker']) await t.test(kind, async child => {
    const f = await fixture(child);
    assert.equal(f.run().status, 0);
    const configurationPath = join(f.state, 'job-runtime.json');
    const original = await readFile(configurationPath);
    const journal = { schemaVersion: 1, receipts: [], qualificationReceipts: [], reconciliations: [],
      jobOutputs: [], jobLogs: [], jobOwners: [] };
    for (const name of ['workflow-operations.json', 'job-runtime-operations.json']) {
      await writeFile(join(f.state, name), JSON.stringify(journal), { mode: 0o600 });
    }
    if (kind === 'unfinished-work') {
      const target = f.input.target;
      journal.receipts.push({ schemaVersion: 1,
        intent: { schemaVersion: 1, protocolVersion: 1, mainId: target.mainInstallationId,
          runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
          technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64),
          inputDigest: `sha256:${'a'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } },
        connection: { mainId: target.mainInstallationId, deviceId: target.hostRef.deviceId,
          workerInstallationId: target.registration.workerInstallationId, bootId: randomUUID(),
          keyRevision: 1, authorizationRevision: 3, connectionGeneration: 1 },
        workerIncarnationId: randomUUID(), sequence: 1, phase: 'received', entryAttempted: false,
        turnEntryAttempted: false, stopFence: false, controls: [] });
      await writeFile(join(f.state, 'workflow-operations.json'), JSON.stringify(journal));
    }
    const reviewed = { expectedConfigurationSha256: kind === 'stale-digest' ? '0'.repeat(64) : hash(original),
      captureInput: { ...f.input, toolchainDigest: '1'.repeat(64) } };
    await writeFile(f.inputPath, JSON.stringify(reviewed), { mode: 0o600 });
    const unlock = kind === 'active-worker' ? await acquireWorkerLock(f.state) : undefined;
    let result;
    try {
      result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(artifact, 'src/cli.mjs'), 'refresh-job-runtime',
        '--state', f.state, '--input', f.inputPath],
      { encoding: 'utf8', timeout: 15000, env: { PATH: '/usr/bin:/bin', HOME: f.directory, LANG: 'C.UTF-8' } });
    } finally { await unlock?.(); }
    if (kind !== 'refresh') {
      assert.equal(result.status, 1);
      const codes = { 'stale-digest': 'job_runtime_configuration_conflict',
        'unfinished-work': 'job_runtime_capture_failed', 'active-worker': 'worker_already_running' };
      assert.equal(result.stderr.trim(), codes[kind]);
      assert.deepEqual(await readFile(configurationPath), original);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.refreshed, true);
    assert.equal(receipt.executionAuthorized, false);
    assert.deepEqual(await readFile(receipt.previousConfigurationPath), original);
    const updated = JSON.parse(await readFile(configurationPath, 'utf8'));
    assert.equal(updated.pins.toolchainDigest, reviewed.captureInput.toolchainDigest);
    assert.equal((await stat(configurationPath)).nlink, 1);
    for (const name of ['identity.json', 'pairing.json', 'approved-roots.json']) {
      assert.equal(hash(await readFile(join(f.state, name))), f.originalFiles[name]);
    }
  });
});

test('packaged capture rejects private-file and destination violations without altering state', { skip: !artifact }, async t => {
  for (const kind of ['input-mode', 'input-symlink', 'input-hardlink', 'existing-output', 'output-symlink', 'missing-identity', 'missing-roots']) await t.test(kind, async child => {
    const f = await fixture(child);
    if (kind === 'input-mode') await chmod(f.inputPath, 0o644);
    if (kind === 'input-symlink') { await rm(f.inputPath); await symlink(join(f.state, 'pairing.json'), f.inputPath); }
    if (kind === 'input-hardlink') await link(f.inputPath, join(f.directory, 'input-alias'));
    if (kind === 'existing-output') await writeFile(join(f.state, 'job-runtime.json'), 'retained config', { mode: 0o600 });
    if (kind === 'output-symlink') await symlink(join(f.state, 'identity.json'), join(f.state, 'job-runtime.json'));
    if (kind === 'missing-identity') { await rm(join(f.state, 'identity.json')); delete f.originalFiles['identity.json']; }
    if (kind === 'missing-roots') { await rm(join(f.state, 'approved-roots.json')); delete f.originalFiles['approved-roots.json']; }
    const before = await readdir(f.state), result = f.run();
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes('a'.repeat(64)));
    assert.deepEqual(await readdir(f.state), before); await f.unchanged();
    if (kind === 'existing-output') assert.equal(await readFile(join(f.state, 'job-runtime.json'), 'utf8'), 'retained config');
  });
});

test('packaged capture rejects caller pins, identity drift and roots outside the reviewed configuration', { skip: !artifact }, async t => {
  for (const kind of ['pins', 'ready', 'main', 'device', 'installation', 'authorization', 'runtime', 'source', 'stale-inode', 'read-only']) await t.test(kind, async child => {
    const f = await fixture(child), input = f.input;
    if (kind === 'pins') input.pins = {};
    if (kind === 'ready') input.ready = true;
    if (kind === 'main') input.target.mainInstallationId = randomUUID();
    if (kind === 'device') input.target.hostRef.deviceId = randomUUID();
    if (kind === 'installation') input.target.registration.workerInstallationId = randomUUID();
    if (kind === 'authorization') input.target.registration.authorizationRevision++;
    if (kind === 'runtime') input.runtimeRoot = f.directory;
    if (kind === 'source') input.root.binding.canonicalPath = f.directory;
    if (kind === 'stale-inode') input.root.binding.filesystem.inode = '0';
    if (kind === 'read-only') input.root.binding.accessMode = 'read-only';
    await writeFile(f.inputPath, JSON.stringify(input));
    const before = await readdir(f.state), result = f.run();
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.deepEqual(await readdir(f.state), before); await f.unchanged();
  });
});

test('packaged capture refuses active worker ownership and unsupported overwrite/relative-input options', { skip: !artifact }, async t => {
  const f = await fixture(t), before = await readdir(f.state), unlock = await acquireWorkerLock(f.state);
  try { const result = f.run(); assert.equal(result.status, 1); assert.equal(result.stderr.trim(), 'worker_already_running'); }
  finally { await unlock(); }
  for (const args of [['--force'], ['--overwrite'], ['--input', 'relative.json']]) {
    const result = f.run(args); assert.equal(result.status, 1); assert.match(result.stderr, /usage/);
  }
  assert.deepEqual(await readdir(f.state), before); await f.unchanged();
});

test('verification starts one disposable test database for the outer pnpm test only', () => {
  assert.equal(needsTestDatabase(['pnpm', 'test'], {}), true);
  assert.equal(needsTestDatabase(['pnpm', 'test:integration'], {}), true);
  assert.equal(needsTestDatabase(['pnpm', 'run', 'test:integration'], {}), true);
  assert.equal(needsTestDatabase(['pnpm', 'test:integration'], { FOREMAN_CODE_CI_TEST_DATABASE: 'running' }), false);
  assert.equal(needsTestDatabase(['pnpm', 'run', 'test'], {}), true);
  assert.equal(needsTestDatabase(['pnpm', 'test'], { FOREMAN_CODE_CI_TEST_DATABASE: 'running' }), false);
  assert.equal(needsTestDatabase(['pnpm', 'install', '--frozen-lockfile'], {}), false);
  assert.equal(needsTestDatabase(['pnpm', 'lint'], {}), false);
});
