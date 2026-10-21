import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { packBrowserRuntime, assembleBrowserRuntime } from '../../../scripts/browser-runtime-install.mjs';
import { stageBrowserRuntime, activateBrowserRuntime, rollbackBrowserRuntime, readInstalledBrowserRuntime,
  checkBrowserRuntimeReadiness, validateBrowserRuntimeManifest, copyBuiltBrowserRuntime } from '../src/browserRuntimeInstall.mjs';
import { installVersion, readInstalledRelease } from '../src/installation.mjs';
import { superviseWorkerUpdate } from '../src/updateSupervisor.mjs';
import { runReleaseCutover, waitForProductionBrowserDrain, stageProductionBrowserRuntime,
  productionBrowserRuntimeLifecycle } from '../../../scripts/local-production-runtime.mjs';
import { browserHostTarget } from './fixtures/browserTarget.mjs';
import { createWorkerBrowserRuntime } from '../src/browserRuntime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const target = { os: 'ubuntu', osRelease: '26.04', arch: 'x64', libc: 'glibc-2.43', node: 'v22.23.2' };
const expected = { protocolVersion: 1, identityFormat: 1 };
const ready = async () => ({ ready: true });

async function fixture(t) {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(parent, 'browser-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function artifact(directory, name, version = '1.0.0') {
  const unit = join(directory, `${name}-unit`), output = join(directory, name);
  const lock = JSON.stringify({ fixture: true, version });
  const files = {
    'python/bin/python3': 'fixture executable, never launched',
    'chromium/chrome': 'fixture executable, never launched',
    'bridge.py': '# fixture bridge', 'browser-use.md': '# fixture skill', 'LICENSES.txt': 'Fixture notices',
    'runtime-lock.json': lock,
    'native-host.mjs': "export async function createBrowserRuntimeProfileCheckpoint({profileStateRoot}) { return { profileCheckpointId: 'fixture-checkpoint', profileStateRoot }; }\nexport async function restoreBrowserRuntimeProfiles() {}\n",
  };
  for (const [path, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(unit, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(unit, path), bytes, { mode: path === 'python/bin/python3' || path === 'chromium/chrome' ? 0o700 : 0o600 });
  }
  const result = await packBrowserRuntime({ unit, output, manifest: { format: 1, kind: 'foreman-browser-runtime',
    runtimeVersion: version, foremanVersion: version, sourceCommit: 'a'.repeat(40), profileFormat: 1, target,
    sourceInputs: [], pythonVersion: '3.13.16', browserUseVersion: '0.13.11', browserHarnessVersion: '0.1.13',
    chromiumVersion: '153.0.8010.12', resolvedLockSha256: hash(lock), pythonExecutable: 'python/bin/python3',
    chromiumExecutable: 'chromium/chrome', bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' } });
  return { ...result, output };
}

async function stage(runtimeRoot, artifact, readiness = ready) {
  return stageBrowserRuntime({ runtimeRoot, artifact: artifact.output, expectedSha256: artifact.descriptorSha256,
    target, readiness, activate: false });
}

test('packing identical complete units at different build paths produces the same immutable artifact', async t => {
  const directory = await fixture(t);
  const first = await artifact(directory, 'first'), second = await artifact(directory, 'second');
  assert.equal(first.descriptorSha256, second.descriptorSha256);
  assert.equal(first.descriptor.archiveSha256, second.descriptor.archiveSha256);
});

test('retains document-template filenames while rejecting unsafe archive paths', async t => {
  const directory = await fixture(t);
  const first = await artifact(directory, 'template');
  const unit = join(directory, 'template-unit');
  const path = 'python/lib/docx/templates/[Content_Types].xml';
  await mkdir(dirname(join(unit, path)), { recursive: true });
  await writeFile(join(unit, path), '<Types>Preserved template</Types>');
  const output = join(directory, 'extended');
  const packed = await packBrowserRuntime({ unit, output, manifest: first.manifest });
  const installed = await stage(join(directory, 'runtime'), { ...packed, output });
  assert.equal(await readFile(join(installed.rootDirectory, path), 'utf8'), '<Types>Preserved template</Types>');
  const entry = packed.manifest.files.find(file => file.path === path);
  assert.ok(entry);
  for (const unsafe of ['../outside', '/absolute', 'C:/absolute', 'nested/../outside', 'nested//file',
    'nested/./file', 'nested\\file', 'control\u0000file']) {
    assert.throws(() => validateBrowserRuntimeManifest({ ...packed.manifest,
      files: [...packed.manifest.files, { ...entry, path: unsafe }] }, target));
  }
});

test('an existing assembly output is preserved without invoking a resolver or downloader', async t => {
  const directory = await fixture(t), output = join(directory, 'existing');
  await mkdir(output); await writeFile(join(output, 'owned-by-user.txt'), 'keep this');
  let invoked = false;
  await assert.rejects(assembleBrowserRuntime({ output, repository: directory, commit: 'a'.repeat(40), target,
    foremanVersion: '1.0.0', run: async () => { invoked = true; throw new Error('must not run'); },
    fetchArtifact: async () => { invoked = true; throw new Error('must not download'); } }), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'owned-by-user.txt'), 'utf8'), 'keep this');
  assert.equal(invoked, false);
});

test('bad chunks and unconfirmed readiness never publish a runtime selection', async t => {
  const directory = await fixture(t), runtimeRoot = join(directory, 'runtime');
  const broken = await artifact(directory, 'broken');
  await writeFile(join(broken.output, broken.descriptor.chunks[0].path), 'corrupted');
  await assert.rejects(stage(runtimeRoot, broken), /checksum|size|chunk/i);
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot, target }), /BROWSER_RUNTIME_MISSING/);
  const valid = await artifact(directory, 'valid');
  await assert.rejects(stage(runtimeRoot, valid, async () => ({ ready: false })), /readiness/i);
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot, target }), /BROWSER_RUNTIME_MISSING/);
});

test('a verified browser unit accepts a compatible Node patch without accepting a different native target', async t => {
  const directory = await fixture(t);
  const packed = await artifact(directory, 'runtime');
  const installed = await stageBrowserRuntime({ runtimeRoot: join(directory, 'runtime-root'), artifact: packed.output,
    expectedSha256: packed.descriptorSha256, target: { ...target, node: 'v22.23.3' }, readiness: ready, activate: false });
  assert.equal(installed.runtimeVersion, '1.0.0');
  for (const incompatible of [{ ...target, arch: 'arm64' }, { ...target, libc: 'glibc-2.35' }, { ...target, node: 'v20.0.0' }]) {
    assert.throws(() => validateBrowserRuntimeManifest(packed.manifest, incompatible), /target mismatch/);
  }
});

test('consumes runner artifacts by source and native target and rejects corrupt transferred chunks', async t => {
  const directory = await fixture(t), packed = await artifact(directory, 'built');
  const commit = 'a'.repeat(40);
  await writeFile(join(packed.output, 'index.json'), JSON.stringify({ format: 1, sourceCommit: commit,
    artifacts: [{ directory: '.', target, descriptorSha256: packed.descriptorSha256 }] }));
  const output = join(directory, 'consumed');
  const copied = await copyBuiltBrowserRuntime({ directory: packed.output, output, target: { ...target, node: 'v22.23.3' }, commit });
  assert.equal(copied.descriptorSha256, packed.descriptorSha256);
  assert.equal((await stage(join(directory, 'installed'), { output, ...copied })).runtimeVersion, '1.0.0');
  await assert.rejects(copyBuiltBrowserRuntime({ directory: packed.output, output: join(directory, 'wrong-source'),
    target, commit: 'b'.repeat(40) }), /source mismatch/);
  await assert.rejects(copyBuiltBrowserRuntime({ directory: packed.output, output: join(directory, 'wrong-target'),
    target: { ...target, osRelease: '24.04' }, commit }), /matching target runner/);
  await writeFile(join(packed.output, packed.descriptor.chunks[0].path), 'corrupt');
  await assert.rejects(copyBuiltBrowserRuntime({ directory: packed.output, output: join(directory, 'corrupt'), target, commit }), /checksum mismatch/);
});

test('staging stays inactive, activation drains before selection, and rollback restores profiles before selecting older Chromium', async t => {
  const directory = await fixture(t), runtimeRoot = join(directory, 'runtime'), events = [];
  const first = await stage(runtimeRoot, await artifact(directory, 'old'));
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot, target }), /BROWSER_RUNTIME_MISSING/);
  await activateBrowserRuntime({ runtimeRoot, staged: first, drain: async () => ({ profileCheckpointId: 'first', profileStateRoot: directory }) });
  const next = await stage(runtimeRoot, await artifact(directory, 'new', '1.1.0'));
  const receipt = await activateBrowserRuntime({ runtimeRoot, staged: next, drain: async () => {
    events.push('drain'); assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, first.manifestSha256);
    return { profileCheckpointId: 'compatible-old-data', profileStateRoot: directory };
  }, onPrepared: async value => {
    events.push('checkpoint-journal'); assert.equal(value.profileCheckpointId, 'compatible-old-data');
    assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, first.manifestSha256);
  } });
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, next.manifestSha256);
  await rollbackBrowserRuntime({ runtimeRoot, ...receipt, drain: async () => { events.push('stop-new-writers'); },
    restoreProfiles: async checkpointId => {
      events.push('restore-profile'); assert.equal(checkpointId, 'compatible-old-data');
      assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, next.manifestSha256);
    } });
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, first.manifestSha256);
  assert.deepEqual(events, ['drain', 'checkpoint-journal', 'stop-new-writers', 'restore-profile']);
});

async function workerCarrier(directory, packed) {
  const root = join(directory, 'carrier'), files = [];
  await mkdir(join(root, 'src'), { recursive: true, mode: 0o700 });
  await writeFile(join(root, 'src/cli.mjs'), '// fixture');
  const runtime = join(root, 'artifacts/browser-runtime'); await mkdir(runtime, { recursive: true, mode: 0o700 });
  for (const path of await readdir(packed.output)) await writeFile(join(runtime, path), await readFile(join(packed.output, path)), { mode: 0o600 });
  for (const path of ['src/cli.mjs', ...(await readdir(runtime)).map(path => `artifacts/browser-runtime/${path}`)]) {
    const bytes = await readFile(join(root, path)); files.push({ path, size: bytes.length, sha256: hash(bytes) });
  }
  const manifest = { format: 1, version: '1.0.0', protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target, files,
    browserRuntime: { descriptorSha256: packed.descriptorSha256, manifestSha256: packed.descriptor.manifestSha256 } };
  const bytes = JSON.stringify(manifest); await writeFile(join(root, 'manifest.json'), bytes, { mode: 0o600 });
  return { artifact: root, approvedManifestSha256: hash(bytes) };
}

test('same-release repair activates a missing browser selection and remains idempotent', async t => {
  const directory = await fixture(t), root = join(directory, 'app'), stateDirectory = join(directory, 'state');
  await mkdir(root, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  const packed = await artifact(directory, 'runtime'), carrier = await workerCarrier(directory, packed);
  const options = { root, stateDirectory, ...carrier, facts: { ...target, rootPersistent: true, homePersistent: true }, expected,
    browserRuntimeReadiness: ready };
  await installVersion(options);
  // Simulate only the public runtime selection being lost, preserving the approved Worker installation.
  const current = await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime') });
  await rollbackBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime'), previousReference: null,
    nextReference: `versions/${current.manifestSha256}`, profileCheckpointId: null, drain: async () => undefined });
  await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime') }), /BROWSER_RUNTIME_MISSING/);
  await installVersion(options);
  assert.equal((await readInstalledRelease(options)).manifest.version, '1.0.0');
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime') })).manifestSha256, current.manifestSha256);
  await installVersion(options);
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime') })).manifestSha256, current.manifestSha256);
});

test('installs the core Worker when browser readiness fails and retries from the selected release', async t => {
  const directory = await fixture(t), root = join(directory, 'app'), stateDirectory = join(directory, 'state');
  await mkdir(root, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  const carrier = await workerCarrier(directory, await artifact(directory, 'runtime'));
  const options = { root, stateDirectory, ...carrier, facts: { ...target, rootPersistent: true, homePersistent: true }, expected,
    browserRuntimeReadiness: async () => { throw new Error('Sandbox support is unavailable'); } };
  const installed = await installVersion(options);
  assert.equal((await readInstalledRelease(options)).manifest.version, '1.0.0');
  assert.equal(installed.browserRuntimeStatus.state, 'failed');
  assert.match(installed.browserRuntimeStatus.reason, /Sandbox support is unavailable/);
  assert.equal(installed.browserRuntimeStatus.retryable, true);
  const status = JSON.parse(await readFile(join(root, 'browser-runtime/status.json'), 'utf8'));
  assert.deepEqual(status, installed.browserRuntimeStatus);
  const repaired = await installVersion({ ...options, artifact: installed.directory, browserRuntimeReadiness: ready });
  assert.equal(repaired.directory, installed.directory);
  assert.equal(repaired.browserRuntimeStatus.state, 'ready');
  assert.equal((await readInstalledBrowserRuntime({ runtimeRoot: join(root, 'browser-runtime') })).runtimeVersion, '1.0.0');
  assert.equal(JSON.parse(await readFile(join(root, 'browser-runtime/status.json'), 'utf8')).state, 'ready');
});

test('Main stages its core release with visible browser failure and can retry that release after prerequisites recover', async t => {
  const directory = await fixture(t), release = join(directory, 'release'), appRoot = join(directory, 'app');
  const target = await browserHostTarget();
  const bytes = Buffer.from(JSON.stringify({ target, files: [] }));
  const manifestSha256 = hash(bytes);
  const artifacts = join(release, 'worker-artifacts');
  await mkdir(join(artifacts, manifestSha256), { recursive: true, mode: 0o700 });
  await writeFile(join(artifacts, manifestSha256, 'manifest.json'), bytes);
  await writeFile(join(artifacts, 'index.json'), JSON.stringify({ artifacts: [{ target, manifestSha256 }] }));
  assert.equal(await stageProductionBrowserRuntime({ release, appRoot,
    stage: async () => { throw new Error('Runner browser prerequisite unavailable'); } }), null);
  const failed = JSON.parse(await readFile(join(release, 'browser-runtime.json'), 'utf8'));
  assert.equal(failed.state, 'failed');
  assert.equal(failed.retryable, true);
  assert.match(failed.reason, /Runner browser prerequisite unavailable/);
  const lifecycle = productionBrowserRuntimeLifecycle({ appRoot, stateDirectory: join(directory, 'state') });
  await lifecycle.verify(release);
  assert.equal((await lifecycle.activate(release, 'activate')).changed, false);
  const staged = { rootDirectory: join(directory, 'runtime'), manifestSha256: 'c'.repeat(64), target };
  assert.deepEqual(await stageProductionBrowserRuntime({ release, appRoot, stage: async () => staged }), staged);
  assert.equal(JSON.parse(await readFile(join(release, 'browser-runtime.json'), 'utf8')).state, 'ready');
});

test('supervisor stops a failed new host and restores browser profiles before restarting the previous Worker', async () => {
  const events = [], record = { format: 1, manifestSha256: 'new-worker', status: {
    state: 'restarting', currentVersion: '1.0.0', targetVersion: '1.1.0', manifestSha256: 'old-worker' }, restart: {
    service: 'graphql-worker.service', root: '/fixture', stateDirectory: '/fixture/state', directory: '/fixture/new',
    previousDirectory: '/fixture/old', previousVersion: '1.0.0', requestId: 'request', pointer: { kind: 'symlink', path: '/fixture/current' },
    browserRuntime: { changed: true, state: 'active' } } };
  await superviseWorkerUpdate(record, { prepareService: async () => undefined, persist: async () => undefined,
    switchPointer: async (_pointer, directory) => { events.push(`select:${directory}`); },
    stop: async () => { events.push('stop-new'); }, restart: async () => { events.push('restart'); },
    ready: async ({ version }) => { if (version === '1.1.0') throw new Error('new host failed'); },
    browserRollback: async () => { events.push('restore-profile-and-runtime'); }, smoke: async () => undefined });
  assert.equal(record.status.state, 'rolled-back');
  assert(events.indexOf('stop-new') < events.indexOf('restore-profile-and-runtime'));
  assert(events.indexOf('restore-profile-and-runtime') < events.lastIndexOf('select:/fixture/old'));
});

test('Main waits for explicit browser lease release and cancels admission drain on timeout', async () => {
  const calls = [];
  await waitForProductionBrowserDrain({ stateDirectory: '/fixture', commandId: 'same', timeoutMs: 1000,
    request: async request => { calls.push(request.operation); return { state: calls.length === 1 ? 'waiting' : 'drained', activeSessions: 1 }; },
    sleep: async () => undefined, log: () => undefined });
  assert.deepEqual(calls, ['beginDrain', 'status']);
  const rejected = [];
  await assert.rejects(waitForProductionBrowserDrain({ stateDirectory: '/fixture', commandId: 'same', timeoutMs: 0,
    request: async request => { rejected.push(request.operation); return { state: request.operation === 'cancelDrain' ? 'canceled' : 'waiting', activeSessions: 1 }; },
    log: () => undefined }), /still active/);
  assert.deepEqual(rejected, ['beginDrain', 'cancelDrain']);
});

test('Main cutover drains before stop and restores runtime before the previous API selection', async t => {
  const directory = await fixture(t), events = [];
  const steps = { pendingMigrations: async () => [], stop: async () => { events.push('stop'); },
    migrate: async () => undefined, upgradeLauncher: async () => undefined, enable: async () => undefined,
    activate: async release => { events.push(`app:${release}`); }, start: async () => undefined,
    ready: async release => { if (release === 'new') throw new Error('new API failed'); }, browserRuntime: {
      beginDrain: async () => { events.push('browser-drain'); },
      activate: async (_release, transactionId, prepared) => {
        const receipt = { transactionId, changed: true }; await prepared(receipt); events.push('runtime:new'); return receipt;
      }, rollback: async () => { events.push('runtime:restore'); }, cancelDrain: async () => { events.push('resume-browser'); },
      verify: async () => undefined } };
  await assert.rejects(runReleaseCutover({ release: 'new', previousRelease: 'old', stateFile: join(directory, 'deployment.json'), steps }), /new API failed/);
  assert(events.indexOf('browser-drain') < events.indexOf('stop'));
  assert(events.indexOf('runtime:restore') < events.indexOf('app:old'));
  assert(events.lastIndexOf('resume-browser') > events.indexOf('app:old'));
});

function bootstrapFixture(overrides = {}) {
  const events = [], failures = [], identity = 'e'.repeat(64);
  const unused = async () => { throw new Error('This bootstrap fixture does not admit browser operations.'); };
  /** @type {import('../../api/src/modules/browser-runtime/types.js').BrowserSubjectAuthority} */
  const subjectAuthority = { resolve: unused, assertCurrent: unused };
  /** @type {import('../../api/src/modules/browser-profiles/keys.js').BrowserPairingAuthority} */
  const pairing = { current: unused, assertCurrent: unused, wrappingKey: unused, assertInstallation: unused };
  /** @type {import('../../api/src/modules/browser-runtime/hostFactory.js').BrowserHostKeyRequests} */
  const keys = { exportKey: unused, snapshotKey: unused };
  const descriptor = { rootDirectory: '/fixture/runtime', manifestSha256: identity, runtimeVersion: '1.0.0',
    profileFormat: 1, target, nativeHostModule: '/fixture/runtime/native-host.mjs',
    pythonExecutable: '/fixture/runtime/python/bin/python3', chromiumExecutable: '/fixture/runtime/chromium/chrome',
    bridgeScript: '/fixture/runtime/bridge.py' };
  let nativePaused = false;
  const host = { status: () => ({ ready: !nativePaused }),
    stopAdmission: () => { nativePaused = true; events.push('pause-admission'); },
    resumeAdmission: () => { nativePaused = false; events.push('resume-admission'); },
    drainForRuntimeUpdate: async () => { events.push('checkpoint'); return { profileCheckpointId: 'before-update',
      profileStateRoot: '/fixture/state/browser/profile-data' }; },
    close: async () => { events.push('stop-host'); } };
  const module = { createBrowserHost: async options => {
    events.push('create-host'); assert.equal(options.runtime, descriptor); return host;
  }, restoreBrowserRuntimeProfiles: async input => { events.push('restore-profile'); return input; } };
  const options = { root: '/fixture/installation', stateDirectory: '/fixture/state', computerId: 'worker',
    installationId: 'installation', facts: target, expected, subjectAuthority, pairing, keys,
    assertHostOwnership: async () => { events.push('assert-owner'); }, reportFailure: error => failures.push(error),
    readSelectedRelease: async () => { events.push('read-release'); return { manifest: { browserRuntime: { manifestSha256: identity } } }; },
    readInstalled: async () => { events.push('verify-unit'); return descriptor; },
    loadModule: async () => { events.push('load-host-module'); return module; }, ...overrides };
  return { options, descriptor, module, host, events, failures, runtime: createWorkerBrowserRuntime(options) };
}

test('Worker status is passive and a missing unit reports runtime_missing without importing or launching a host', async () => {
  const fixture = bootstrapFixture({ readInstalled: async () => { throw new Error('BROWSER_RUNTIME_MISSING'); } });
  assert.equal(fixture.runtime.status().reason, 'runtime_missing');
  assert.deepEqual(fixture.events, []);
  assert.equal((await fixture.runtime.start()).reason, 'runtime_missing');
  assert.equal(fixture.runtime.getHost(), null);
  assert.equal(fixture.events.includes('load-host-module'), false);
  assert.equal(fixture.events.includes('create-host'), false);
  assert.equal(fixture.failures.length, 1);
});

test('the running Worker owner reports the retained browser failure and repairs from its selected release', async t => {
  const directory = await fixture(t), root = join(directory, 'app'), stateDirectory = join(directory, 'state');
  await mkdir(root, { mode: 0o700 }); await mkdir(stateDirectory, { mode: 0o700 });
  const carrier = await workerCarrier(directory, await artifact(directory, 'runtime'));
  const facts = { ...target, rootPersistent: true, homePersistent: true };
  const installed = await installVersion({ root, stateDirectory, ...carrier, facts, expected,
    browserRuntimeReadiness: async () => { throw new Error('Sandbox prerequisite unavailable'); } });
  const f = bootstrapFixture();
  const owner = createWorkerBrowserRuntime({ ...f.options, root, stateDirectory, facts,
    readSelectedRelease: readInstalledRelease, readInstalled: readInstalledBrowserRuntime,
    browserRuntimeReadiness: ready, loadModule: async () => ({ ...f.module, createBrowserHost: async () => f.host }) });
  t.after(() => owner.close());
  const failed = await owner.start();
  assert.equal(failed.phase, 'failed');
  assert.match(failed.message, /Sandbox prerequisite unavailable/);
  assert.equal(failed.retryable, true);
  assert.equal((await owner.retry()).ready, true);
  assert.equal((await readInstalledRelease({ root, facts, expected })).directory, installed.directory);
  assert.equal(owner.getHost(), f.host);
});

test('Worker refuses a mismatched selected release and a selection that changes while its module loads', async () => {
  const mismatched = bootstrapFixture({ readSelectedRelease: async () => ({ manifest: {
    browserRuntime: { manifestSha256: 'f'.repeat(64) } } }) });
  assert.equal((await mismatched.runtime.start()).ready, false);
  assert.equal(mismatched.events.includes('load-host-module'), false);
  let reads = 0;
  const changed = bootstrapFixture({ readSelectedRelease: async () => ({ manifest: {
    browserRuntime: { manifestSha256: (++reads === 1 ? 'e' : 'f').repeat(64) } } }) });
  assert.equal((await changed.runtime.start()).ready, false);
  assert.equal(changed.events.includes('load-host-module'), true);
  assert.equal(changed.events.includes('create-host'), false);
  assert.equal(changed.runtime.getHost(), null);
});

test('Worker bootstrap shares one host and exposes distinct checkpoint, stop and compatible-profile restore operations', async () => {
  const { runtime, events, host, module } = bootstrapFixture();
  const starts = await Promise.all([runtime.start(), runtime.start()]);
  assert(starts.every(result => result.ready));
  assert.equal(events.filter(event => event === 'create-host').length, 1);
  assert.equal(runtime.getHost(), host); assert.equal(runtime.getModule(), module);
  const checkpoint = await runtime.drain();
  assert.equal(runtime.status().ready, false);
  assert.equal(checkpoint.profileCheckpointId, 'before-update');
  await assert.rejects(runtime.restoreProfiles(checkpoint.profileCheckpointId), /Stop the new browser host/);
  await runtime.stop();
  assert.equal(runtime.getHost(), null);
  assert.deepEqual(await runtime.restoreProfiles(checkpoint.profileCheckpointId), {
    checkpointId: 'before-update', profileStateRoot: '/fixture/state/browser/profile-data' });
  assert.equal(events.filter(event => event === 'checkpoint').length, 1);
  assert(events.indexOf('stop-host') < events.indexOf('restore-profile'));
});

test('a busy Worker drain restores ordinary admission and preserves the active owner for a later drain', async () => {
  const { runtime, host, events } = bootstrapFixture();
  let active = true;
  host.drainForRuntimeUpdate = async () => {
    if (active) throw new Error('BROWSER_RUNTIME_BUSY');
    return { profileCheckpointId: 'released', profileStateRoot: '/fixture/state/browser/profile-data' };
  };
  await runtime.start();
  await assert.rejects(runtime.drain(), /BROWSER_RUNTIME_BUSY/);
  assert.equal(runtime.status().ready, true);
  assert.equal(runtime.getHost(), host);
  active = false;
  assert.equal((await runtime.drain()).profileCheckpointId, 'released');
  assert.equal(runtime.status().ready, false);
  assert.equal(events.includes('stop-host'), false);
});

for (const previouslyInstalled of [false, true]) {
  test(`Worker updates checkpoint profiles with no live host (${previouslyInstalled ? 'incompatible installation' : 'missing installation'})`, async t => {
    const directory = await fixture(t), runtimeRoot = join(directory, 'app/browser-runtime');
    const previous = await stage(runtimeRoot, await artifact(directory, 'previous'));
    if (previouslyInstalled) await activateBrowserRuntime({ runtimeRoot, staged: previous,
      drain: async () => ({ profileCheckpointId: 'initial', profileStateRoot: join(directory, 'state/browser/profile-data') }) });
    const replacement = await stage(runtimeRoot, await artifact(directory, 'replacement', '1.1.0'));
    const f = bootstrapFixture();
    const owner = createWorkerBrowserRuntime({ ...f.options, root: join(directory, 'app'),
      stateDirectory: join(directory, 'state'), runtimeRoot,
      readSelectedRelease: async () => ({ manifest: { browserRuntime: { manifestSha256: previous.manifestSha256 } } }),
      readInstalled: readInstalledBrowserRuntime,
      loadModule: async () => { throw new Error('Installed browser host is incompatible'); },
    });
    t.after(() => owner.close());
    assert.equal((await owner.start()).ready, false);
    assert.equal(owner.getHost(), null);
    const activated = await activateBrowserRuntime({ runtimeRoot, staged: replacement,
      drain: input => owner.drain(input) });
    assert.equal(activated.profileCheckpointId, 'fixture-checkpoint');
    assert.equal(activated.profileStateRoot, join(directory, 'state/browser/profile-data'));
    assert.equal((await readInstalledBrowserRuntime({ runtimeRoot, target })).manifestSha256, replacement.manifestSha256);
    await rollbackBrowserRuntime({ runtimeRoot, ...activated,
      drain: () => owner.stop(), restoreProfiles: checkpoint => owner.restoreProfiles(checkpoint) });
    if (previouslyInstalled) {
      assert.equal((await readInstalledBrowserRuntime({ runtimeRoot, target })).manifestSha256, previous.manifestSha256);
    } else {
      await assert.rejects(readInstalledBrowserRuntime({ runtimeRoot, target }), /BROWSER_RUNTIME_MISSING/);
    }
  });
}

test('Worker stop fences a delayed initial host before it can be exposed as available', async () => {
  const { runtime, module, host, events } = bootstrapFixture();
  let complete;
  let creationStarted;
  const started = new Promise(resolve => { creationStarted = resolve; });
  module.createBrowserHost = async () => {
    creationStarted();
    return new Promise(resolve => { complete = () => resolve(host); });
  };
  const opening = runtime.start();
  await started;
  const stopping = runtime.stop();
  complete();
  assert.equal((await opening).ready, false);
  await stopping;
  assert.equal(runtime.getHost(), null);
  assert(events.indexOf('pause-admission') < events.indexOf('stop-host'));
});

test('Worker retains failed cleanup ownership and will not restore profiles until that cleanup settles', async () => {
  const { runtime, host } = bootstrapFixture();
  let pending = true;
  host.close = async () => { if (pending) throw new Error('native cleanup pending'); };
  await runtime.start();
  await assert.rejects(runtime.stop(), /native cleanup pending/);
  assert.equal(runtime.getHost(), host);
  await assert.rejects(runtime.restoreProfiles('before-update'), /Stop the new browser host/);
  pending = false;
  await runtime.stop();
  await runtime.restoreProfiles('before-update');
  await runtime.close();
  await assert.rejects(runtime.start(), /has been closed/);
});


test('readiness preserves an explicitly configured Chromium sandbox in its private subprocess', async t => {
  const directory = await fixture(t);
  const python = join(directory, 'python');
  const helper = '/fixture/browser-sandbox';
  await writeFile(join(directory, 'manifest.json'), '{}');
  const script = ['#!/bin/sh', '[ "$CHROME_DEVEL_SANDBOX" = "/fixture/browser-sandbox" ] || exit 19',
    '[ "$TMPDIR" = "/fixture/browser-tmp" ] || exit 23',
    `printf '%s\\n' '{"ready":true}'`, ''].join('\n');
  await writeFile(python, script, { mode: 0o700 });
  const previous = process.env.CHROME_DEVEL_SANDBOX;
  const previousTemporary = process.env.TMPDIR;
  process.env.CHROME_DEVEL_SANDBOX = helper;
  process.env.TMPDIR = '/fixture/browser-tmp';
  try {
    assert.deepEqual(await checkBrowserRuntimeReadiness({ rootDirectory: directory,
      pythonExecutable: python, chromiumExecutable: join(directory, 'chrome') }), { ready: true });
  } finally {
    if (previous === undefined) delete process.env.CHROME_DEVEL_SANDBOX;
    else process.env.CHROME_DEVEL_SANDBOX = previous;
    if (previousTemporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemporary;
  }
});

test('readiness keeps generated browser home state out of the release-owned helper workspace', async t => {
  const directory = await fixture(t);
  const python = join(directory, 'python');
  await writeFile(join(directory, 'manifest.json'), '{}');
  const script = ['#!/bin/sh', 'mkdir -p "$HOME/.config/browser-state"',
    'printf metadata > "$HOME/.config/browser-state/settings"', `printf '%s\\n' '{"ready":true}'`, ''].join('\n');
  await writeFile(python, script, { mode: 0o700 });
  const descriptor = { rootDirectory: directory, pythonExecutable: python,
    chromiumExecutable: join(directory, 'chrome') };
  assert.deepEqual(await checkBrowserRuntimeReadiness(descriptor), { ready: true });
  assert.deepEqual(await readdir(join(directory, 'empty-workspace')), []);
  assert.deepEqual(await checkBrowserRuntimeReadiness(descriptor), { ready: true });
});

test('verifies readiness without putting an installed file inventory in process arguments', async t => {
  const directory = await fixture(t);
  const python = join(directory, 'python');
  const files = Array.from({ length: 3000 }, (_, index) => ({ path: `python/lib/package/module-${index}.py`,
    size: 1, sha256: 'a'.repeat(64), mode: 0o600 }));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ pythonVersion: '3.13.16',
    browserUseVersion: '0.13.11', browserHarnessVersion: '0.1.13', chromiumVersion: '153.0.8010.12', files }));
  await writeFile(python, ['#!/bin/sh', `printf '%s\\n' '{"ready":true}'`, ''].join('\n'), { mode: 0o700 });
  assert.deepEqual(await checkBrowserRuntimeReadiness({ rootDirectory: directory,
    pythonExecutable: python, chromiumExecutable: join(directory, 'chrome') }), { ready: true });
});
