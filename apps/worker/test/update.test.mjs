import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { createInstalledWorkerUpdater } from '../src/installedUpdater.mjs';
import { WorkerUpdater, downloadWorkerArtifact, fetchGitHubAsset } from '../src/update.mjs';
import { installVersion, readInstalledRelease, readRetainedRelease } from '../src/installation.mjs';
import { startWorker, acquireWorkerLock, readWorkerStatus } from '../src/runtime.mjs';
import { WorkerError } from '../src/diagnostics.mjs';
import { readUpdateRecord, superviseWorkerUpdate, waitForWorkerReady, locateWorkerLaunch,
  launchUpdateSupervisor } from '../src/updateSupervisor.mjs';
import { recoverPendingWorkerUpdate, writeUpdateRecord, migrateWorkerService } from '../src/updateSupervisor.mjs';
import { switchWorkerPointer } from '../src/updateSupervisor.mjs';
import { WORKER_UPDATE_STARTUP_TIMEOUT_MS } from '../src/ciSmokeTiming.mjs';
import { renderUserService } from '../src/service.mjs';
import { workerArtifactContentSha256 } from '../../../packages/contracts/src/workerArtifactContentNode.mjs';
import { DeviceConnectionError } from '../../../apps/api/src/modules/devices/deviceWire.ts';
import { DeviceApplicationError } from '../../../apps/api/src/modules/devices/deviceApplicationError.ts';
import { COMPUTER_MAINTENANCE_NAMESPACE } from '@foreman-code/contracts/computer-maintenance';
import { packBrowserRuntime } from '../../../scripts/browser-runtime-install.mjs';
import { stageBrowserRuntime, activateBrowserRuntime, readInstalledBrowserRuntime, readBrowserRuntimeStatus } from '../src/browserRuntimeInstall.mjs';
let bundleDirectory;
let createWorkerRuntimeDrain;
before(async () => {
  bundleDirectory = await mkdtemp(join(persistentFixtureRoot, 'worker-update-module-'));
  const output = join(bundleDirectory, 'drain.mjs');
  const domains = new URL('../../../apps/api/src/modules/devices/installedWorkerDomains.ts', import.meta.url);
  const contracts = JSON.parse(await readFile(new URL('../../../packages/contracts/package.json', import.meta.url)));
  const alias = Object.fromEntries(Object.entries(contracts.exports).map(([name, entry]) => [
    name === '.' ? '@foreman-code/contracts' : `@foreman-code/contracts${name.slice(1)}`,
    fileURLToPath(new URL(`../../../packages/contracts/${entry.import.replace('./dist/', 'src/').replace(/\.js$/, '.ts')}`,
      import.meta.url)),
  ]));
  await build({ stdin: {
    contents: `export { createWorkerRuntimeDrain } from ${JSON.stringify(fileURLToPath(domains))};`,
    resolveDir: fileURLToPath(new URL('../../../', import.meta.url)),
  }, outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['sharp'], alias,
  banner: { js: "import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(import.meta.url);" } });
  ({ createWorkerRuntimeDrain } = await import(pathToFileURL(output).href));
});
after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };
const expected = { protocolVersion: 1, identityFormat: 1 };
const releaseTarget = { os: facts.os, osRelease: facts.osRelease, arch: facts.arch, libc: facts.libc, node: facts.node };

async function artifact(base, version) {
  const directory = join(base, `artifact-${version}`);
  await mkdir(join(directory, 'src'), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(`console.log('${version}');\n`);
  await writeFile(join(directory, 'src/cli.mjs'), bytes, { mode: 0o600 });
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version, commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1,
    target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', sha256: hash(bytes), size: bytes.length }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'manifest.json'), manifestBytes, { mode: 0o600 });
  return { directory, release: { version, manifestSha256: hash(manifestBytes), manifest,
    github: { repository: 'example/product', tag: `worker-${manifest.commit}` } } };
}

async function fixture(t, targetVersion = '1.1.0') {
  const base = await mkdtemp(join(persistentFixtureRoot, 'worker-update-'));
  const root = join(base, 'app');
  const stateDirectory = join(base, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const previous = await artifact(base, '1.0.0');
  const incoming = await artifact(base, targetVersion);
  await installVersion({ root, stateDirectory, facts, expected, artifact: previous.directory,
    approvedManifestSha256: previous.release.manifestSha256 });
  const workerInstallationId = randomUUID();
  let runtime;
  let assertStateOwnership;
  let beforeUnlock;
  const connections = [];
  const boot = async (version, phase = 'ready') => {
    runtime = await startWorker({ stateDirectory, appVersion: version,
      beforeUnlock: () => beforeUnlock?.(),
      loadIdentity: async () => ({ workerInstallationId }),
      readBootId: async () => '11111111-1111-4111-8111-111111111111',
      createConnection: async input => {
        assertStateOwnership = input.assertStateOwnership;
        connections.push(version);
        return { start: async () => {}, stop: async () => {}, status: () => ({ phase }) };
      } });
  };
  await boot('1.0.0');
  t.after(async () => {
    await runtime?.stop();
    await rm(base, { recursive: true, force: true });
  });
  const requests = [];
  const request = async payload => {
    requests.push(payload);
    if (payload.operation === 'release') return { payload: { operation: 'release', release: incoming.release } };
    if (payload.operation === 'ci-smoke') return { payload: { operation: 'ci-smoke', ciSmoke: null } };
    throw new Error(`Unexpected Main request: ${payload.operation}`);
  };
  const launch = { root, stateDirectory, service: 'graphql-worker.service',
    pointer: { kind: 'symlink', path: join(root, 'current') },
    previousDirectory: (await readInstalledRelease({ root, facts, expected })).directory,
    unitPath: join(base, '.config/systemd/user/graphql-worker.service') };
  await mkdir(join(launch.unitPath, '..'), { recursive: true, mode: 0o700 });
  const template = await readFile(new URL('../artifacts/graphql-worker.service.in', import.meta.url), 'utf8');
  await writeFile(launch.unitPath, renderUserService(template, { node: process.execPath, app: root,
    state: stateDirectory, home: base, path: '/usr/bin:/bin',
    entrypoint: join(launch.previousDirectory, 'src/cli.mjs') }), { mode: 0o600 });
  const prepareService = plan => migrateWorkerService(plan, { run: async (_binary, args) => ({
    stdout: args.includes('--property=FragmentPath') ? `${launch.unitPath}\n` : '',
  }) });
  const options = { stateDirectory, version: '1.0.0', manifestSha256: previous.release.manifestSha256,
    releaseDirectory: launch.previousDirectory, workerInstallationId, facts,
    assertStateOwnership: () => assertStateOwnership(), connection: () => ({ captureRequest: () => ({ request }) }),
    fetchAsset: async ({ github, destination, signal }) => {
      assert.deepEqual(github, incoming.release.github);
      signal?.throwIfAborted();
      const result = spawnSync('tar', ['-czf', destination, '-C', incoming.directory, '.']);
      assert.equal(result.status, 0, result.stderr.toString());
    },
    drain: async () => {}, resume: () => {}, locateLaunch: async () => launch,
    launchSupervisor: async () => {} };
  return { base, root, stateDirectory, previous, incoming, requests, options, connections, prepareService,
    setBeforeUnlock: callback => { beforeUnlock = callback; }, stopRuntime: () => runtime.stop(),
    restart: async phase => {
      await runtime.stop();
      const unit = await readFile(launch.unitPath, 'utf8');
      const [, node, entrypoint] = unit.match(/^ExecStart=(\S+) (\S+)/m);
      const child = spawnSync(node, [entrypoint, 'run', '--state', stateDirectory], { encoding: 'utf8', timeout: 2000 });
      assert.equal(child.status, 0, child.stderr);
      await boot(child.stdout.trim(), phase);
    } };
}

async function browserArtifact(base, version, output) {
  const unit = join(base, `browser-unit-${version}`), lock = '{}';
  const entries = { 'python/bin/python3': 'fixture python', 'chromium/chrome': 'fixture chromium',
    'bridge.py': '# fixture bridge', 'browser-use.md': '# fixture skill', 'LICENSES.txt': 'Fixture notices',
    'runtime-lock.json': lock, 'native-host.mjs': 'export const fixture = true;' };
  for (const [path, bytes] of Object.entries(entries)) {
    await mkdir(dirname(join(unit, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(unit, path), bytes, { mode: path.endsWith('python3') || path.endsWith('chrome') ? 0o700 : 0o600 });
  }
  return packBrowserRuntime({ unit, output, manifest: { format: 1, kind: 'foreman-browser-runtime',
    runtimeVersion: version, foremanVersion: version, sourceCommit: 'a'.repeat(40), profileFormat: 1, target: releaseTarget,
    sourceInputs: [], pythonVersion: '3.13.16', browserUseVersion: '0.13.11', browserHarnessVersion: '0.1.13',
    chromiumVersion: '153.0.8010.12', resolvedLockSha256: hash(lock), pythonExecutable: 'python/bin/python3',
    chromiumExecutable: 'chromium/chrome', bridgeScript: 'bridge.py', nativeHostModule: 'native-host.mjs', skill: 'browser-use.md' } });
}

async function addIncomingBrowser(f) {
  const output = join(f.incoming.directory, 'artifacts/browser-runtime');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const packed = await browserArtifact(f.base, '1.1.0', output);
  const manifest = f.incoming.release.manifest;
  for (const path of await readdir(output)) {
    const bytes = await readFile(join(output, path));
    manifest.files.push({ path: `artifacts/browser-runtime/${path}`, size: bytes.length, sha256: hash(bytes) });
  }
  manifest.browserRuntime = { descriptorSha256: packed.descriptorSha256, manifestSha256: packed.descriptor.manifestSha256 };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(f.incoming.directory, 'manifest.json'), bytes, { mode: 0o600 });
  f.incoming.release.manifestSha256 = hash(bytes);
}

for (const rollback of [false, true]) {
  test(`browser readiness failure permits a running core update while preserving browser activation through ${rollback ? 'core rollback' : 'restart'}`, async t => {
    const f = await fixture(t);
    await addIncomingBrowser(f);
    const oldArtifact = join(f.base, 'old-browser');
    const packed = await browserArtifact(f.base, '1.0.0', oldArtifact);
    const runtimeRoot = join(f.root, 'browser-runtime');
    const retained = await stageBrowserRuntime({ runtimeRoot, artifact: oldArtifact, expectedSha256: packed.descriptorSha256,
      target: facts, readiness: async () => ({ ready: true }), activate: false });
    await activateBrowserRuntime({ runtimeRoot, staged: retained,
      drain: async () => ({ profileCheckpointId: 'retained-profile', profileStateRoot: f.stateDirectory }) });
    const events = [];
    let probes = 0;
    const updater = await new WorkerUpdater({ ...f.options,
      browserRuntimeReadiness: async () => { probes++; throw new Error('Browser prerequisite unavailable'); },
      browserRuntimeLifecycle: { drain: async () => { events.push('browser-drain'); },
        stop: async () => { events.push('browser-stop'); }, restoreProfiles: async () => { events.push('browser-restore'); } },
      drain: async () => { events.push('core-drain'); },
      launchSupervisor: async () => {
        const record = await readUpdateRecord(f.stateDirectory);
        assert.equal(record.restart.browserRuntime, undefined);
        assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
        await superviseWorkerUpdate(record, { prepareService: f.prepareService, restart: () => f.restart('ready'),
          ready: async input => {
            if (rollback && input.version === '1.1.0') throw new Error('Core startup failed');
            await waitForWorkerReady(input);
          } });
      } }).initialize();
    t.after(() => updater.close());
    await updater.start();
    assert.equal(probes, 1);
    assert.deepEqual(events, ['core-drain']);
    assert.deepEqual(f.connections, rollback ? ['1.0.0', '1.1.0', '1.0.0'] : ['1.0.0', '1.1.0']);
    assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, rollback ? 'rolled-back' : 'current');
    assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, rollback ? '1.0.0' : '1.1.0');
    assert.equal((await readInstalledBrowserRuntime({ runtimeRoot })).manifestSha256, retained.manifestSha256);
    assert.deepEqual(await readBrowserRuntimeStatus(f.root), { state: 'failed', retryable: true,
      manifestSha256: f.incoming.release.manifestSha256, reason: 'Browser prerequisite unavailable' });
  });
}

for (const failHandoff of [false, true]) {
  test(`installed updater carries browser checkpoint and rollback ownership through ${failHandoff ? 'failed handoff' : 'activation'}`, async t => {
    const f = await fixture(t);
    await addIncomingBrowser(f);
    const events = [];
    const browser = {
      stopAdmission() { events.push('pause'); },
      drain: async () => { events.push('domain-drain'); },
      resumeAdmission: async () => { events.push('resume'); },
      runtime: {
        drain: async () => { events.push('checkpoint'); return { profileCheckpointId: 'profile-checkpoint', profileStateRoot: f.stateDirectory }; },
        stop: async () => { events.push('stop'); },
        restoreProfiles: async checkpoint => { assert.equal(checkpoint, 'profile-checkpoint'); events.push('restore'); },
      },
    };
    const updater = await createInstalledWorkerUpdater({ ...f.options, browser,
      domains: () => ({ drainForUpdate: async () => { events.push('core-drain'); }, resumeAfterUpdate: async () => {} }),
      browserRuntimeReadiness: async () => ({ ready: true }),
      launchSupervisor: async () => {
        events.push('handoff');
        if (failHandoff) throw new Error('Supervisor could not start');
      },
    });
    t.after(() => updater.close());
    if (failHandoff) await assert.rejects(updater.start(), /Supervisor could not start/);
    else assert.match(await updater.start(), /restart is scheduled/);
    assert.deepEqual(events.slice(0, 4), ['pause', 'core-drain', 'domain-drain', 'checkpoint']);
    assert.ok(events.includes('handoff'));
    if (failHandoff) {
      assert.ok(events.includes('stop'));
      assert.ok(events.includes('restore'));
    } else {
      const record = await readUpdateRecord(f.stateDirectory);
      assert.equal(record.status.state, 'restarting');
      assert.equal(record.restart.browserRuntime.profileCheckpointId, 'profile-checkpoint');
    }
  });
}

test('stopping a running Worker during browser readiness still aborts the core update', async t => {
  const f = await fixture(t);
  await addIncomingBrowser(f);
  const entered = Promise.withResolvers();
  let drains = 0, restarts = 0;
  const updater = await new WorkerUpdater({ ...f.options,
    browserRuntimeReadiness: async (_descriptor, { signal }) => {
      entered.resolve();
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, drain: async () => { drains++; }, launchSupervisor: async () => { restarts++; } }).initialize();
  t.after(() => updater.close());
  const updating = updater.start();
  const rejected = assert.rejects(updating, error => error.code === 'worker_updater_stopped');
  await entered.promise;
  await updater.close();
  await rejected;
  assert.equal(drains, 0);
  assert.equal(restarts, 0);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
});

async function until(predicate) {
  for (let count = 0; count < 200; count++) {
    if (await predicate()) return;
    await wait(5);
  }
  throw new Error('Worker update did not reach the expected state.');
}

async function waitForFile(path) {
  await until(async () => {
    try {
      await readFile(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function waitForStartupWithClock(t, options) {
  return waitForWorkerReady({ ...options, timeoutMs: 15, pollMs: 1,
    readStatus: async directory => {
      const status = await readWorkerStatus(directory);
      if (status?.phase === 'authenticating') t.mock.timers.tick(15);
      return status;
    } });
}

async function assertStalledUpdateRetry(t, { beforeDownload = async () => {} } = {}) {
  const f = await fixture(t);
  const drainEntered = Promise.withResolvers();
  let drainSignal;
  let releaseDrain;
  const blocked = new Promise(resolve => { releaseDrain = resolve; });
  let resumed = 0;
  let installs = 0;
  let restarted = 0;
  let stall = true;
  const updater = await new WorkerUpdater({ ...f.options, attemptTimeoutMs: 150,
    fetchAsset: async input => {
      await beforeDownload();
      return f.options.fetchAsset(input);
    },
    drain: signal => {
      drainSignal = signal;
      drainEntered.resolve();
      return stall ? blocked : Promise.resolve();
    },
    resume: () => { resumed++; },
    stage: async options => { installs++; return { directory: options.artifact }; },
    launchSupervisor: async () => { restarted++; } }).initialize();
  t.after(async () => { releaseDrain(); await updater.close(); });
  // Real download and persisted writes must reach drain before the test advances the attempt clock.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = updater.start().then(() => 'completed', error => error);
  await Promise.race([drainEntered.promise, attempt.then(outcome => {
    assert.fail(`Update finished before drain: ${outcome.message ?? outcome}`);
  })]);
  assert.equal((await updater.status()).state, 'draining');
  t.mock.timers.tick(149);
  assert.equal(drainSignal.aborted, false);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'draining');
  assert.equal(resumed, 0);
  assert.equal(installs, 0);
  assert.equal(restarted, 0);
  t.mock.timers.tick(1);
  assert.equal(drainSignal.aborted, true);
  const outcome = await attempt;
  assert.equal(outcome.code, 'worker_update_deadline_exceeded');
  const record = await readUpdateRecord(f.stateDirectory);
  assert.equal(record.status.state, 'failed');
  assert.match(record.status.lastError, /draining/);
  assert.equal(record.failureCode, 'worker_update_deadline_exceeded');
  assert.equal(resumed, 1);
  releaseDrain();
  await attempt;
  assert.equal(installs, 0);
  assert.equal(restarted, 0);
  stall = false;
  await updater.start();
  assert.equal(installs, 1);
  assert.equal(restarted, 1);
}

test('a stalled update attempt persists its deadline, resumes work, and can retry', async t => {
  await assertStalledUpdateRetry(t);
});

test('a stalled update can resume and retry after slow artifact preparation', async t => {
  await assertStalledUpdateRetry(t, { beforeDownload: () => wait(150) });
});

test('Worker update persists the original attempt deadline across a long drain and supervisor handoff', async t => {
  const f = await fixture(t);
  const began = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: began });
  let handedOff;
  const updater = await new WorkerUpdater({ ...f.options,
    drain: async () => { t.mock.timers.tick(29 * 60_000); },
    launchSupervisor: async stateDirectory => { handedOff = await readUpdateRecord(stateDirectory); },
  }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal(handedOff.status.state, 'restarting');
  assert.equal(handedOff.attemptDeadlineAt, began + 45 * 60_000);
  assert.equal(handedOff.attemptDeadlineAt - Date.now(), 16 * 60_000);
});

test('Worker status advertises the running manifest even after a failed target update', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.save({ state: 'rolled-back', lastError: 'worker_update_startup_timeout' },
    { manifestSha256: f.incoming.release.manifestSha256 });
  assert.equal((await updater.status()).manifestSha256, f.previous.release.manifestSha256);
});

test('update supervision allows bounded capacity drain and smoke before rolling back', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService, restart: () => f.restart('ready'),
      ready: async options => {
        assert.ok(options.timeoutMs >= 30 * 60_000 + 160_000,
          'Startup supervision must include the capacity wait and smoke execution budgets.');
        await waitForWorkerReady({ ...options, timeoutMs: 1000, pollMs: 1 });
      },
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'current');
});

test('downloads a release from its GitHub release asset and still verifies every byte against the manifest', async t => {
  const base = await mkdtemp(join(persistentFixtureRoot, 'worker-github-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const built = await artifact(base, '1.2.0');
  const archive = join(base, 'asset.tar.gz');
  spawnSync('tar', ['-czf', archive, '-C', built.directory, '.']);
  const github = { repository: 'octo/site', tag: `worker-${'c'.repeat(40)}` };
  const requested = [];
  const fetchAsset = async input => {
    requested.push({ github: input.github, asset: input.asset });
    await writeFile(input.destination, await readFile(archive));
  };
  const request = async () => { throw new Error('No chunk may come through Main.'); };
  const release = { ...built.release, github };
  const installed = join(base, 'installed');
  let completion;
  const manifest = await downloadWorkerArtifact({ release, request, directory: installed, facts, fetchAsset,
    onDownloadComplete: async details => { completion = details; },
  });
  assert.deepEqual(completion, { source: 'github' });
  assert.deepEqual(requested, [{ github, asset: `${built.release.manifestSha256}.tar.gz` }]);
  assert.equal(manifest.version, '1.2.0');
  assert.equal(spawnSync(process.execPath, [join(installed, 'src/cli.mjs')], { encoding: 'utf8' }).stdout, '1.2.0\n');

  await writeFile(join(built.directory, 'src/cli.mjs'), "console.log('2.1.0');\n");
  spawnSync('tar', ['-czf', archive, '-C', built.directory, '.']);
  await assert.rejects(downloadWorkerArtifact({ release, request, directory: join(base, 'tampered'), facts, fetchAsset }),
    { code: 'artifact_checksum_mismatch' });
});

test('a stalled GitHub asset fails visibly without draining or requesting Main bundle bytes', async t => {
  const f = await fixture(t);
  const binaries = join(f.base, 'bin');
  await mkdir(binaries);
  const started = join(f.base, 'github-started');
  await writeFile(join(binaries, 'gh'),
    `#!/bin/sh\nexec node -e 'require("node:fs").writeFileSync(process.argv[1], "started"); process.stderr.write("fixture GitHub stalled\\n"); setInterval(() => {}, 1000);' '${started}'\n`,
    { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduleTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    scheduleTimeout(callback, delay === 60000 ? 100 : delay, ...args));
  let retryLogged = false;
  let drained = false;
  const updater = await new WorkerUpdater({ ...f.options, fetchAsset: fetchGitHubAsset,
    downloadTimeoutMs: 1000, drain: async () => { drained = true; },
    log: (_msg, fields) => { if (fields.retryMs) retryLogged = true; } }).initialize();
  t.after(() => updater.close());
  const rejected = assert.rejects(updater.start(), { code: 'WORKER_RELEASE_ASSET_UNAVAILABLE' });
  await waitForFile(started);
  t.mock.timers.tick(100);
  await until(() => retryLogged);
  t.mock.timers.tick(900);
  await rejected;
  assert.deepEqual(f.requests.map(payload => payload.operation), ['release']);
  const status = await updater.status();
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /stall|no bytes/i);
  assert.equal(drained, false);
});

test('a temporarily unavailable GitHub asset is retried without Main bytes, with each phase logged', async t => {
  const f = await fixture(t);
  f.incoming.release.github = { repository: 'example/product', tag: `worker-${'a'.repeat(40)}` };
  const archive = join(f.base, 'asset.tar.gz');
  spawnSync('tar', ['-czf', archive, '-C', f.incoming.directory, '.']);
  const binaries = join(f.base, 'bin');
  const attempts = join(f.base, 'gh-attempts');
  await mkdir(binaries);
  const releaseLookup = join(binaries, 'release-lookup');
  // Hold the lookup until the test has exercised the download watchdog clock.
  await writeFile(join(binaries, 'lookup.mjs'), `import { watch, existsSync } from 'node:fs';
const gate = process.argv[2];
const watcher = watch(process.argv[3], () => {
  if (existsSync(gate)) { watcher.close(); console.error('release not found'); process.exitCode = 1; }
});
if (existsSync(gate)) { watcher.close(); console.error('release not found'); process.exitCode = 1; }
`);
  await writeFile(join(binaries, 'gh'), `#!/bin/sh\necho attempt >> '${attempts}'\n`
    + `if [ "$(wc -l < '${attempts}')" -eq 1 ]; then exec node '${join(binaries, 'lookup.mjs')}' '${releaseLookup}' '${binaries}'; fi\n`
    + `exec cat '${archive}'\n`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduleTimeout = globalThis.setTimeout;
  // Advance retry spacing independently of the subprocess no-bytes watchdog.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) =>
    scheduleTimeout(callback, delay === 5000 ? 20 : delay, ...args));
  const logged = [];
  const updater = await new WorkerUpdater({ ...f.options, fetchAsset: fetchGitHubAsset, downloadTimeoutMs: 3000,
    log: (msg, fields = {}) => logged.push({ msg, ...fields }) }).initialize();
  t.after(() => updater.close());

  const update = updater.start();
  await waitForFile(attempts);
  t.mock.timers.tick(20);
  await writeFile(releaseLookup, 'available');
  await until(() => logged.some(entry => entry.retryMs));
  assert.ok(logged.some(entry => /GitHub/.test(entry.msg) && /release not found/.test(entry.error ?? '')));
  t.mock.timers.tick(20);
  assert.equal(await update, 'Worker 1.1.0 restart is scheduled.');
  const record = await readUpdateRecord(f.stateDirectory);
  assert.equal(record.status.state, 'restarting');
  assert.equal(record.downloadSource, 'github');
  assert.equal(f.requests.some(payload => payload.operation === 'chunk'), false);
  for (const file of f.incoming.release.manifest.files) {
    assert.deepEqual(await readFile(join(record.restart.directory, file.path)),
      await readFile(join(f.incoming.directory, file.path)));
  }
  const phases = logged.filter(entry => entry.phase).map(entry => entry.phase);
  assert.deepEqual(phases.filter((phase, index) => phases.indexOf(phase) === index),
    ['release', 'downloading', 'smoke configuration', 'draining', 'installing', 'restarting']);
  assert.ok(logged.some(entry => /GitHub/.test(entry.msg) && /release not found/.test(entry.error ?? '')));
});

test('GitHub recovery still rejects a file that does not match its announced checksum', async t => {
  const f = await fixture(t);
  await writeFile(join(f.incoming.directory, 'src/cli.mjs'), 'corrupted bytes');
  let completed = false;
  let attempts = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let retryLogged = false;
  const download = downloadWorkerArtifact({ release: f.incoming.release, facts,
    directory: join(f.base, 'corrupt-github'), fetchAsset: async options => {
      if (++attempts === 1) throw new WorkerError('worker_update_github_unavailable', 'GitHub unavailable');
      await f.options.fetchAsset(options);
    }, onDownloadComplete: async () => { completed = true; },
    log: (_msg, fields) => { if (fields.retryMs) retryLogged = true; },
  });
  const rejected = assert.rejects(download, { code: 'artifact_file_size_mismatch' });
  await until(() => retryLogged);
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(attempts, 2);
  assert.equal(completed, false);
  assert.deepEqual(f.requests, []);
});

test('GitHub retries use the original download deadline after a failed attempt', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduleTimeout = globalThis.setTimeout;
  let deadlineTimers = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay === 100) deadlineTimers++;
    return scheduleTimeout(callback, delay, ...args);
  });
  let retryLogged = false;
  const download = downloadWorkerArtifact({ release: f.incoming.release, facts,
    directory: join(f.base, 'bounded-github'), timeoutMs: 100,
    fetchAsset: async () => {
      throw new WorkerError('worker_update_github_unavailable', 'GitHub unavailable');
    },
    log: (_msg, fields) => { if (fields.retryMs) retryLogged = true; },
  });
  const rejected = assert.rejects(download, error => {
    assert.equal(error.code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
    assert.match(error.message, /GitHub unavailable/);
    return true;
  });
  await until(() => retryLogged);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(deadlineTimers, 1);
  assert.deepEqual(f.requests, []);
});

test('authenticated-ready check detects Main version mismatch, installs and reconnects at the matching version', async t => {
  const f = await fixture(t);
  let supervised;
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    supervised = superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService,
    });
    await supervised;
  } }).initialize();
  t.after(() => updater.close());
  updater.ready();
  await until(async () => (await readUpdateRecord(f.stateDirectory)).status.state === 'current'
    && f.connections.length === 2);
  await supervised;
  assert.deepEqual(f.connections, ['1.0.0', '1.1.0']);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.1.0');
  assert.equal((await readRetainedRelease(f.root)).manifest.version, '1.0.0');
  const restarted = await new WorkerUpdater({ ...f.options, version: '1.1.0',
    releaseDirectory: (await readInstalledRelease({ root: f.root, facts, expected })).directory,
    manifestSha256: f.incoming.release.manifestSha256 }).initialize();
  assert.deepEqual(await restarted.status(), { target: releaseTarget, currentVersion: '1.1.0', targetVersion: '1.1.0',
    contentSha256: workerArtifactContentSha256(f.incoming.release.manifest),
    manifestSha256: f.incoming.release.manifestSha256,
    state: 'current', lastError: null });
  restarted.close();
});

test('concurrent status polling preserves saved update transitions and metadata', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  const manifestSha256 = f.incoming.release.manifestSha256;
  const pending = updater.save({ targetVersion: '1.1.0', state: 'pending' }, { manifestSha256 });
  const pendingStatus = updater.status();
  const draining = updater.save({ state: 'draining' });
  const drainingStatus = updater.status();
  await Promise.all([pending, draining]);
  assert.deepEqual(await pendingStatus, { target: releaseTarget, currentVersion: '1.0.0', targetVersion: '1.1.0',
    contentSha256: workerArtifactContentSha256(f.previous.release.manifest),
    manifestSha256: f.previous.release.manifestSha256,
    state: 'pending', lastError: null });
  const status = await drainingStatus;
  assert.deepEqual(status, { target: releaseTarget, currentVersion: '1.0.0', targetVersion: '1.1.0',
    contentSha256: workerArtifactContentSha256(f.previous.release.manifest),
    manifestSha256: f.previous.release.manifestSha256,
    state: 'draining', lastError: null });
  const retained = await readUpdateRecord(f.stateDirectory);
  assert.deepEqual(retained.status, status);
  assert.equal(retained.manifestSha256, manifestSha256);
});

test('busy work drains naturally after the verified download and before installation or restart', async t => {
  const f = await fixture(t);
  let finishWork;
  let resumed = 0;
  const work = new Promise(resolve => { finishWork = resolve; });
  const updater = await new WorkerUpdater({ ...f.options, drain: () => work,
    resume: () => { resumed++; } }).initialize();
  t.after(() => {
    finishWork();
    return updater.close();
  });
  const update = updater.start();
  await until(async () => (await updater.status()).state === 'draining');
  assert.equal(f.requests.some(request => request.operation === 'chunk'), false);
  assert.equal((await readUpdateRecord(f.stateDirectory)).downloadSource, 'github');
  assert.equal(resumed, 0);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  finishWork();
  await update;
  assert.equal((await updater.status()).state, 'restarting');
  assert.equal(resumed, 0);
});

test('an idle Worker keeps admitting work while its update downloads slowly from GitHub', async t => {
  const f = await fixture(t);
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: async () => {}, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  let finishDownload;
  const downloaded = new Promise(resolve => { finishDownload = resolve; });
  let downloadWaiting = false;
  const updater = await new WorkerUpdater({ ...f.options, drain: () => drain.run(), resume: () => drain.resume(),
    fetchAsset: async options => {
      downloadWaiting = true;
      await downloaded;
      await f.options.fetchAsset(options);
    } }).initialize();
  t.after(() => {
    finishDownload();
    return updater.close();
  });
  const update = updater.start();
  await until(() => downloadWaiting);
  assert.equal((await updater.status()).state, 'downloading');
  assert.doesNotThrow(() => drain.assertAdmission('harness-discovery-v1', {}));
  assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method: 'prepare' }));
  finishDownload();
  assert.equal(await update, 'Worker 1.1.0 restart is scheduled.');
  assert.throws(() => drain.assertAdmission('harness-discovery-v1', {}), { code: 'WORKER_RUNTIME_DRAINING' });
});

for (const path of ['manifest.json', 'src/cli.mjs']) {
  test(`rejects changed ${path} bytes and keeps the running release admitting work`, async t => {
    const f = await fixture(t);
    const originalBytes = await readFile(join(f.incoming.directory, path));
    await writeFile(join(f.incoming.directory, path), Buffer.alloc(originalBytes.length, 7));
    const current = await readlink(join(f.root, 'current'));
    let drained = 0;
    let resumed = 0;
    let launched = false;
    const updater = await new WorkerUpdater({ ...f.options, drain: async () => { drained++; },
      resume: () => { resumed++; }, launchSupervisor: async () => { launched = true; } }).initialize();
    t.after(() => updater.close());
    await assert.rejects(updater.start(), error => error.code === (path === 'manifest.json'
      ? 'manifest_checksum_mismatch' : 'artifact_checksum_mismatch'));
    assert.equal(await readlink(join(f.root, 'current')), current);
    assert.equal((await updater.status()).state, 'failed');
    assert.equal(drained, 0);
    assert.equal(resumed, 0);
    assert.equal(launched, false);
  });
}

test('failed new startup restores the previous pointer and persists rollback across Worker restart', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let restarts = 0;
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService,
      restart: async () => { await f.restart(++restarts === 1 ? 'authenticating' : 'ready'); },
      ready: options => waitForStartupWithClock(t, options),
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.deepEqual(f.connections, ['1.0.0', '1.1.0', '1.0.0']);
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const restarted = await new WorkerUpdater(f.options).initialize();
  const { lastError, ...status } = await restarted.status();
  assert.deepEqual(status, { target: releaseTarget, currentVersion: '1.0.0', targetVersion: '1.1.0',
    contentSha256: workerArtifactContentSha256(f.previous.release.manifest),
    manifestSha256: f.previous.release.manifestSha256, state: 'rolled-back' });
  assert.match(lastError, /worker_update_startup_timeout/);
  assert.match(lastError, /authenticating/);
  await restarted.start();
  assert.equal(restarts, 2);
  restarted.close();
});

test('authenticated Main rollback can install its matching older version without changing manual install policy', async t => {
  const f = await fixture(t, '0.9.0');
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '0.9.0');
});

test('supervisor launch failure keeps the old pointer and resumes admissions with persisted failure', async t => {
  const f = await fixture(t);
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; },
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  assert.equal(resumed, 1);
  assert.equal((await updater.status()).lastError, 'worker_update_supervisor_unavailable');
});

for (const launchTimeout of [false, true]) {
  test(`an unresolved supervisor handoff keeps admissions closed (launch timeout: ${launchTimeout})`, async t => {
    const f = await fixture(t);
    let resumed = 0;
    const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; },
      launchSupervisor: async stateDirectory => {
        const now = Date.now();
        let clock = now;
        const date = t.mock.method(Date, 'now', () => { clock += 10_001; return clock; });
        try {
          await launchUpdateSupervisor(stateDirectory, { run: async () => {
            if (launchTimeout) throw Object.assign(new Error('systemd-run timed out'), { killed: true, signal: 'SIGTERM' });
            return { stdout: '' };
          } });
        } finally { date.mock.restore(); }
      } }).initialize();
    t.after(() => updater.close());
    await assert.rejects(updater.start(), { code: 'worker_update_supervisor_handoff_pending' });
    assert.equal(resumed, 0);
    assert.equal((await updater.status()).state, 'restarting');
    await assert.rejects(updater.start({ retry: true }), { code: 'worker_update_restart_pending' });
    const record = await readUpdateRecord(f.stateDirectory);
    assert.equal(record.restart.restartAttempted, false);
    record.supervisorStarted = record.restart.requestId;
    await writeUpdateRecord(f.stateDirectory, record);
    // Only a reconciled outcome proving neither restart happened may reopen this process.
    await assert.rejects(superviseWorkerUpdate(record, {
      prepareService: f.prepareService,
      switchPointer: async () => { throw new Error('Pointer storage unavailable'); },
      restart: async () => assert.fail('Restart should not be reached.'),
    }), { code: 'worker_update_rollback_failed' });
    assert.equal((await updater.status()).state, 'failed');
    assert.equal(resumed, 1);
    await updater.status();
    assert.equal(resumed, 1);
  });
}

test('runtime drain blocks maintenance starts until recovery resumes admission', async () => {
  let finishJobs;
  const jobsFinished = new Promise(resolve => { finishJobs = resolve; });
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: () => jobsFinished, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  const completion = drain.run();
  try {
    assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
      { code: 'WORKER_RUNTIME_DRAINING' });
    assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status' }));
  } finally {
    finishJobs();
    await completion;
  }
  assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status' }));
  drain.resume();
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }));
});

test('runtime drain fences workflow and Job admission while allowing status reads', async () => {
  const drained = [];
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [],
    drainJobs: async () => { drained.push('jobs'); },
    drainQualifications: async () => { drained.push('qualifications'); },
    drainMaintenance: async () => { drained.push('maintenance'); },
    quiescent: async () => true });
  const completion = drain.run();
  for (const method of ['prepare', 'job-dispatch', 'start-turn']) {
    assert.throws(() => drain.assertAdmission('execution-v1', { method }),
      { code: 'WORKER_RUNTIME_DRAINING' });
  }
  assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method: 'status' }));
  await completion;
  assert.deepEqual(drained, ['jobs', 'qualifications', 'maintenance']);
  assert.throws(() => drain.assertAdmission('execution-v1', { method: 'prepare' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  drain.resume();
  for (const method of ['prepare', 'start-turn', 'job-dispatch']) {
    assert.doesNotThrow(() => drain.assertAdmission('execution-v1', { method }));
  }
});

test('terminal supervisor failure resumes maintenance Retry only for the unchanged original release', async t => {
  const f = await fixture(t);
  const drain = createWorkerRuntimeDrain({ signal: new AbortController().signal,
    active: () => [], drainJobs: async () => {}, drainQualifications: async () => {},
    drainMaintenance: async () => {}, quiescent: async () => true });
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, drain: () => drain.run(),
    resume: () => { resumed++; drain.resume(); }, launchSupervisor: async stateDirectory => {
      const record = await readUpdateRecord(stateDirectory);
      record.supervisorStarted = record.restart.requestId;
      await writeUpdateRecord(stateDirectory, record);
    } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.throws(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }),
    { code: 'WORKER_RUNTIME_DRAINING' });
  let switches = 0;
  await assert.rejects(superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
    prepareService: f.prepareService,
    switchPointer: async () => { switches++; throw new Error('Pointer storage unavailable'); },
    restart: async () => { throw new Error('Restart must not be attempted'); },
  }), { code: 'worker_update_rollback_failed' });
  assert.equal(switches, 2);
  assert.equal((await updater.status()).state, 'failed');
  assert.equal(resumed, 1);
  assert.doesNotThrow(() => drain.assertAdmission(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'start' }));
  await updater.status();
  assert.equal(resumed, 1);
  assert.equal(await updater.start({ retry: true }), 'Worker 1.1.0 restart is scheduled.');
});

test('terminal supervisor failure cannot resume an ambiguous release pointer', async t => {
  const f = await fixture(t);
  let resumed = 0;
  const updater = await new WorkerUpdater({ ...f.options, resume: () => { resumed++; } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  record.supervisorStarted = record.restart.requestId;
  await writeUpdateRecord(f.stateDirectory, record);
  await assert.rejects(superviseWorkerUpdate(record, {
    prepareService: f.prepareService,
    switchPointer: async () => {
      await rm(record.restart.pointer.path);
      throw new Error('Pointer outcome unavailable');
    },
  }), { code: 'worker_update_rollback_failed' });
  assert.equal((await updater.status()).lastError, 'worker_update_recovery_required');
  assert.equal(resumed, 0);
  await assert.rejects(updater.start({ retry: true }), { code: 'worker_update_recovery_required' });
});

test('the next Worker retries an update cut short by a Worker stop, but not an update that failed', async t => {
  const f = await fixture(t);
  const stageEntered = Promise.withResolvers();
  const finishStage = Promise.withResolvers();
  const stopped = await new WorkerUpdater({ ...f.options,
    stage: async () => {
      stageEntered.resolve();
      await finishStage.promise;
      return { directory: f.incoming.directory };
    },
  }).initialize();
  const update = stopped.start();
  await stageEntered.promise;
  const closing = stopped.close();
  finishStage.resolve();
  await closing;
  await assert.rejects(update, { code: 'worker_updater_stopped' });
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'failed');
  let launched = 0;
  const next = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => { launched++; } }).initialize();
  t.after(() => next.close());
  assert.equal(await next.start(), 'Worker 1.1.0 restart is scheduled.');
  assert.equal(launched, 1);
  assert.equal((await next.status()).state, 'restarting');

  const g = await fixture(t);
  const failed = await new WorkerUpdater({ ...g.options,
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  await assert.rejects(failed.start(), { code: 'worker_update_supervisor_unavailable' });
  await failed.close();
  const later = await new WorkerUpdater({ ...g.options, launchSupervisor: async () => { launched++; } }).initialize();
  t.after(() => later.close());
  assert.equal(await later.start(), 'Worker update needs a retry.');
  assert.equal(launched, 1);
});

test('manual retry clears an earlier failure when Main now serves the already running release', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options,
    launchSupervisor: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  f.incoming.release = f.previous.release;
  assert.equal(await updater.start({ retry: true }), 'Worker 1.0.0 is current.');
  assert.deepEqual(await updater.status(), { target: releaseTarget, currentVersion: '1.0.0', targetVersion: '1.0.0',
    contentSha256: workerArtifactContentSha256(f.previous.release.manifest),
    manifestSha256: f.previous.release.manifestSha256,
    state: 'current', lastError: null });
});

test('an update interrupted by Main restart retries the saved target on the reconnected channel', async t => {
  const f = await fixture(t);
  const originalRequest = f.options.connection().captureRequest().request;
  let available = true;
  let disconnect = true;
  let captures = 0;
  let resumed = 0;
  let launched = 0;
  const options = { ...f.options, resume: () => { resumed++; },
    launchSupervisor: async () => { launched++; },
    connection: () => ({ captureRequest: () => {
      if (!available) return undefined;
      captures++;
      return { request: async payload => {
        if (payload.operation === 'ci-smoke' && disconnect) {
          disconnect = false;
          available = false;
          throw new DeviceConnectionError('transport');
        }
        return originalRequest(payload);
      } };
    } }) };
  const updater = await new WorkerUpdater(options).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_channel_unavailable' });
  const interrupted = await readUpdateRecord(f.stateDirectory);
  assert.equal(interrupted.manifestSha256, f.incoming.release.manifestSha256);
  assert.equal(interrupted.status.lastError, 'worker_update_channel_unavailable');
  // Download and smoke configuration precede the drain, so admissions were never fenced.
  assert.equal(resumed, 0);
  assert.equal(launched, 0);
  assert.equal(await updater.start(), 'Worker update is unavailable on this Main connection.');
  available = true;
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal(captures, 6);
  assert.deepEqual(f.requests.map(payload => payload.operation), ['release', 'release', 'ci-smoke']);
  assert.equal(launched, 1);
  assert.equal((await updater.status()).lastError, null);
});

test('reconnection during a failing update schedules a fresh check after the old channel settles', async t => {
  const f = await fixture(t, '1.0.0');
  let rejectRequest;
  let captures = 0;
  const updater = await new WorkerUpdater({ ...f.options, connection: () => ({ captureRequest: () => {
    captures++;
    if (captures <= 2) return { request: () => new Promise((_resolve, reject) => { rejectRequest = reject; }) };
    return { request: async () => ({ payload: { operation: 'release', release: f.previous.release } }) };
  } }) }).initialize();
  t.after(() => updater.close());
  const interrupted = assert.rejects(updater.start(), { code: 'worker_update_channel_unavailable' });
  await until(() => rejectRequest !== undefined);
  updater.ready();
  rejectRequest(new DeviceConnectionError('authentication'));
  await interrupted;
  await until(async () => captures === 4 && (await updater.status()).state === 'current');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('a persisted channel failure retries automatically after Worker starts on a connected Main', async t => {
  const f = await fixture(t);
  const interrupted = await new WorkerUpdater({ ...f.options, connection: () => ({ captureRequest: () => ({
    request: async () => { throw new DeviceConnectionError('transport'); },
  }) }) }).initialize();
  await assert.rejects(interrupted.start(), { code: 'worker_update_channel_unavailable' });
  await interrupted.close();
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('application channel loss retries without classifying permission or revocation as channel loss', async t => {
  const cases = [
    { error: new DeviceApplicationError('unavailable'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('transport'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('timeout'), expected: 'worker_update_channel_unavailable' },
    { error: new DeviceApplicationError('permission'), expected: 'worker_update_failed' },
    { error: new DeviceConnectionError('revoked'), expected: 'worker_update_failed' },
  ];
  for (const { error, expected } of cases) {
    await t.test(error.code, async t => {
      const f = await fixture(t);
      let connected = false;
      let launched = 0;
      const updater = await new WorkerUpdater({ ...f.options,
        launchSupervisor: async () => { launched++; },
        connection: () => connected ? f.options.connection() : { captureRequest: () => ({
          request: async () => { throw error; },
        }) },
      }).initialize();
      t.after(() => updater.close());
      await assert.rejects(updater.start(), { code: expected });
      const lastError = (await readUpdateRecord(f.stateDirectory)).status.lastError;
      assert.match(lastError, new RegExp(expected));
      if (expected === 'worker_update_failed') assert.match(lastError, new RegExp(error.code));
      assert.equal(launched, 0);
      if (expected === 'worker_update_channel_unavailable') {
        connected = true;
        updater.ready();
        await until(async () => (await updater.status()).state === 'restarting');
        assert.equal(launched, 1);
        assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
      }
    });
  }
});

test('reconnection retries a retained generic update failure from before channel errors were classified', async t => {
  const f = await fixture(t);
  await writeUpdateRecord(f.stateDirectory, { format: 1, manifestSha256: f.incoming.release.manifestSha256,
    status: { currentVersion: '1.0.0', targetVersion: '1.1.0', state: 'failed', lastError: 'worker_update_failed' } });
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  assert.equal(await updater.start(), 'Worker update needs a retry.');
  updater.ready();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('ready health requires both authenticated connection readiness and the original installation identity', async t => {
  const f = await fixture(t);
  await assert.rejects(waitForWorkerReady({ stateDirectory: f.stateDirectory, version: '1.0.0',
    workerInstallationId: randomUUID(), timeoutMs: 10, pollMs: 1 }), { code: 'worker_update_startup_timeout' });
  await waitForWorkerReady({ stateDirectory: f.stateDirectory, version: '1.0.0',
    workerInstallationId: f.options.workerInstallationId });
});

test('existing CI service launch is accepted only when its pointer names the running release', async t => {
  const f = await fixture(t);
  const directory = join(f.base, '.local/share/foreman-code/ci-verification');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'worker-release-path');
  await writeFile(path, `${f.options.releaseDirectory}\n`, { mode: 0o600 });
  const options = { ...f.options, home: f.base, pid: 123, run: async (_binary, args) => ({
    stdout: args.includes('foreman-ci-worker.service') ? '123\n' : '0\n',
  }) };
  const launch = await locateWorkerLaunch(options);
  assert.deepEqual(launch.pointer, { kind: 'file', path });
  await writeFile(path, `${f.incoming.directory}\n`, { mode: 0o600 });
  await assert.rejects(locateWorkerLaunch(options), { code: 'worker_release_pointer_mismatch' });
});

test('external supervisor launch rejects before restart when systemd refuses its transient service', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async stateDirectory => {
    await launchUpdateSupervisor(stateDirectory, {
      run: async () => { throw new WorkerError('worker_update_supervisor_unavailable'); },
    });
  } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), { code: 'worker_update_supervisor_unavailable' });
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
});

test('startup recovers an unfinished restart after its supervisor service disappeared', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  record.restart.unit = `foreman-worker-update-${randomUUID()}`;
  await writeUpdateRecord(f.stateDirectory, record);
  let launches = 0;
  const launch = async stateDirectory => {
    launches++;
    await superviseWorkerUpdate(await readUpdateRecord(stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  };
  await recoverPendingWorkerUpdate(f.stateDirectory, { run: async () => ({ stdout: 'active\n' }), launch });
  assert.equal(launches, 0);
  await recoverPendingWorkerUpdate(f.stateDirectory, { run: async () => ({ stdout: 'inactive\n' }), launch });
  assert.equal(launches, 1);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'current');
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.1.0');
});

for (const ciSmoke of [null, { repository: 'fixture/project', commit: 'c'.repeat(40) }]) {
  test(`startup completes an older update record without an attempt deadline (CI smoke: ${Boolean(ciSmoke)})`, async t => {
    const f = await fixture(t);
    const updater = await new WorkerUpdater(f.options).initialize();
    t.after(() => updater.close());
    await updater.start();
    const record = await readUpdateRecord(f.stateDirectory);
    delete record.attemptDeadlineAt;
    if (ciSmoke) record.restart.ciSmoke = ciSmoke;
    record.restart.unit = `foreman-worker-update-${randomUUID()}`;
    record.restart.restartAttempted = true;
    await f.prepareService(record.restart);
    await switchWorkerPointer(record.restart.pointer, record.restart.directory);
    await writeUpdateRecord(f.stateDirectory, record);
    await f.restart('ready');
    const readiness = [];
    const smokePlans = [];
    let launches = 0;
    await recoverPendingWorkerUpdate(f.stateDirectory, {
      run: async () => ({ stdout: 'inactive\n' }),
      launch: async stateDirectory => {
        launches++;
        await superviseWorkerUpdate(await readUpdateRecord(stateDirectory), {
          restart: () => f.restart('ready'), prepareService: f.prepareService,
          ready: async options => {
            readiness.push({ version: options.version, timeoutMs: options.timeoutMs });
            await waitForWorkerReady({ ...options, pollMs: 1 });
          },
          smoke: async plan => { if (plan.ciSmoke) smokePlans.push(plan.ciSmoke); },
        });
      },
    });
    const saved = await readUpdateRecord(f.stateDirectory);
    assert.equal(launches, 1);
    assert.equal(saved.status.state, 'current');
    assert.equal(saved.status.lastError, null);
    assert.equal(saved.attemptDeadlineAt, undefined);
    assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.1.0');
    assert.deepEqual(readiness, [{ version: '1.1.0',
      timeoutMs: ciSmoke ? 60_000 : WORKER_UPDATE_STARTUP_TIMEOUT_MS }]);
    assert.deepEqual(smokePlans, ciSmoke ? [ciSmoke] : []);
  });
}

test('shutdown waits for an active staging operation and prevents a restart after ownership can change', async t => {
  const f = await fixture(t);
  let finishStage;
  let stageEntered = false;
  let launched = false;
  const gate = new Promise(resolve => { finishStage = resolve; });
  const updater = await new WorkerUpdater({ ...f.options,
    stage: async () => { stageEntered = true; await gate; return { directory: f.incoming.directory }; },
    launchSupervisor: async () => { launched = true; } }).initialize();
  const update = updater.start();
  await until(() => stageEntered);
  const shutdownEntered = Promise.withResolvers();
  f.setBeforeUnlock(() => {
    shutdownEntered.resolve();
    return updater.close();
  });
  let stopped = false;
  const closing = f.stopRuntime().then(() => { stopped = true; });
  await shutdownEntered.promise;
  assert.equal(stopped, false);
  await assert.rejects(acquireWorkerLock(f.stateDirectory), { code: 'worker_already_running' });
  finishStage();
  await assert.rejects(update, { code: 'worker_updater_stopped' });
  await closing;
  assert.equal(stopped, true);
  assert.equal(launched, false);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'failed');
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const releaseOwnership = await acquireWorkerLock(f.stateDirectory);
  await releaseOwnership();
});

test('terminal maintenance outcomes identify the release running after success or rollback', async t => {
  for (const rollback of [false, true]) {
    await t.test(rollback ? 'rollback' : 'success', async t => {
      const f = await fixture(t);
      const startedAt = new Date().toISOString();
      const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
        await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
          prepareService: f.prepareService,
          restart: () => f.restart('ready'),
          smoke: async () => {
            if (rollback) throw new Error('CI smoke failed');
          },
        });
      } }).initialize();
      t.after(() => updater.close());
      await updater.start();
      const installed = await readInstalledRelease({ root: f.root, facts, expected });
      assert.deepEqual(await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt }), {
        target: releaseTarget,
        currentVersion: installed.manifest.version,
        manifestSha256: installed.manifestSha256,
        contentSha256: workerArtifactContentSha256(installed.manifest),
        targetVersion: '1.1.0',
        state: rollback ? 'rolled-back' : 'current',
        lastError: rollback ? 'CI smoke failed' : null,
      });
    });
  }
});

test('consecutive releases retain the first terminal maintenance outcome without an intermediate poll', async t => {
  const f = await fixture(t);
  const startedAt = new Date().toISOString();
  const launchSupervisor = async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      restart: () => f.restart('ready'), prepareService: f.prepareService });
  };
  const first = await new WorkerUpdater({ ...f.options, launchSupervisor }).initialize();
  await first.start();
  await first.close();
  const release = await readInstalledRelease({ root: f.root, facts, expected });
  const next = await artifact(f.base, '1.2.0');
  f.incoming.directory = next.directory;
  f.incoming.release = next.release;
  const second = await new WorkerUpdater({ ...f.options, version: '1.1.0', manifestSha256: release.manifestSha256,
    releaseDirectory: release.directory,
    locateLaunch: async () => ({ ...await f.options.locateLaunch(), previousDirectory: release.directory }),
    launchSupervisor }).initialize();
  await second.start();
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.currentVersion, '1.2.0');
  assert.deepEqual(await second.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt }), {
    target: releaseTarget, currentVersion: '1.1.0', manifestSha256: release.manifestSha256,
    contentSha256: workerArtifactContentSha256(release.manifest),
    targetVersion: '1.1.0', state: 'current', lastError: null,
  });
  await second.close();
});

test('a later successful retry of the same target preserves the earlier task rollback outcome', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let restarts = 0;
  const firstStartedAt = new Date().toISOString();
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService, restart: () => f.restart(++restarts === 1 ? 'authenticating' : 'ready'),
      ready: options => waitForStartupWithClock(t, options),
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  t.mock.timers.tick(2);
  const retryStartedAt = new Date().toISOString();
  await updater.start({ retry: true });
  assert.equal((await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt: firstStartedAt })).state,
    'rolled-back');
  assert.equal((await updater.maintenanceOutcome({ workerTargetVersion: '1.1.0', startedAt: retryStartedAt })).state,
    'current');
});
test('healthy Worker startup rolls back when its CI setup smoke fails', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater({ ...f.options, launchSupervisor: async () => {
    await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
      prepareService: f.prepareService,
      restart: () => f.restart('ready'),
      smoke: async () => { throw new Error('CI setup: missing offline package metadata'); },
    });
  } }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  const persisted = await readUpdateRecord(f.stateDirectory);
  assert.equal(persisted.status.state, 'rolled-back');
  assert.equal(persisted.status.lastError, 'CI setup: missing offline package metadata');
});

test('Worker update persists authenticated CI smoke configuration and rolls back a setup failure', async t => {
  const f = await fixture(t);
  const configuration = { repository: 'octo/project', commit: f.incoming.release.manifest.commit };
  const captured = f.options.connection().captureRequest();
  const updater = await new WorkerUpdater({ ...f.options,
    connection: () => ({ captureRequest: () => ({ request: payload => payload.operation === 'ci-smoke'
      ? Promise.resolve({ payload: { operation: 'ci-smoke', ciSmoke: configuration } }) : captured.request(payload) }) }),
    launchSupervisor: async () => {
      await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
        prepareService: f.prepareService, restart: () => f.restart('ready'),
        smoke: async plan => {
          assert.deepEqual(plan.ciSmoke, configuration);
          throw new Error('CI setup: missing offline package metadata');
        },
      });
    },
  }).initialize();
  t.after(() => updater.close());
  await updater.start();
  assert.equal((await readInstalledRelease({ root: f.root, facts, expected })).manifest.version, '1.0.0');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, 'CI setup: missing offline package metadata');
});


test('update failure retains the failed phase and child stderr in persisted status', async t => {
  const f = await fixture(t);
  const failure = Object.assign(new Error('staging process exited with code 1'), {
    stderr: 'diagnostic padding\n'.repeat(400) + 'Cannot find package dependency-helper\n',
  });
  const updater = await new WorkerUpdater({ ...f.options, stage: async () => { throw failure; } }).initialize();
  t.after(() => updater.close());
  await assert.rejects(updater.start(), error => {
    assert.equal(error.code, 'worker_update_failed');
    assert.match(error.message, /installing/);
    assert.match(error.message, /Cannot find package dependency-helper/);
    return true;
  });
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /staging process exited with code 1/);
  assert.match(status.lastError, /Cannot find package dependency-helper/);
  assert.ok(status.lastError.length <= 2000);
});

test('a stalled GitHub download times out, cancels its request and retries on the next check', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let downloadSignal;
  let stalled = true;
  const options = { ...f.options, downloadTimeoutMs: 50,
    fetchAsset: input => {
      if (!stalled) return f.options.fetchAsset(input);
      downloadSignal = input.signal;
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    } };
  const updater = await new WorkerUpdater(options).initialize();
  t.after(() => updater.close());
  const outcome = updater.start().then(() => 'completed', error => error);
  await until(() => downloadSignal !== undefined);
  t.mock.timers.tick(50);
  const failure = await outcome;
  assert.equal(failure.code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
  assert.equal(downloadSignal.aborted, true);
  assert.match((await updater.status()).lastError, /download.*timed out/i);
  stalled = false;
  options.downloadTimeoutMs = 5000;
  updater.scheduleCheck();
  await until(async () => (await updater.status()).state === 'restarting');
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.lastError, null);
});

test('GitHub download keeps its overall deadline when an attempt takes too long', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const downloadEntered = Promise.withResolvers();
  const finishDownload = Promise.withResolvers();
  const outcome = downloadWorkerArtifact({ release: f.incoming.release, facts,
    directory: join(f.base, 'bounded-download'), timeoutMs: 15,
    fetchAsset: async options => {
      downloadEntered.resolve();
      await finishDownload.promise;
      await f.options.fetchAsset(options);
    },
  }).then(() => 'completed', error => error);
  await downloadEntered.promise;
  t.mock.timers.tick(15);
  finishDownload.resolve();
  assert.equal((await outcome).code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
});

test('startup timeout retains the last observed readiness phase and failure', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await assert.rejects(waitForWorkerReady({ stateDirectory: '/fixture/state', version: '1.1.0',
    workerInstallationId: randomUUID(), timeoutMs: 5, pollMs: 1,
    readStatus: async () => {
      t.mock.timers.tick(5);
      return { active: true, phase: 'backoff', failure: 'authentication', appVersion: '1.1.0' };
    },
  }), error => {
    assert.equal(error.code, 'worker_update_startup_timeout');
    assert.match(error.message, /backoff/);
    assert.match(error.message, /authentication/);
    return true;
  });
});

test('supervisor preserves restart stderr and both update and rollback readiness failures', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  const record = await readUpdateRecord(f.stateDirectory);
  let attempts = 0;
  await assert.rejects(superviseWorkerUpdate(record, {
    prepareService: async () => {}, switchPointer: async () => {},
    restart: async () => {
      if (++attempts === 1) throw Object.assign(new Error('restart exited 1'), { stderr: 'runtime library missing' });
    },
    ready: async () => { throw new Error('rollback authentication failed'); },
  }), { code: 'worker_update_rollback_failed' });
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /runtime library missing/);
  assert.match(status.lastError, /rollback authentication failed/);
});


test('GitHub asset download reports the command stderr tail', async t => {
  const f = await fixture(t);
  const binary = join(f.base, 'gh');
  await writeFile(binary, '#!/bin/sh\nprintf "release asset not found\\n" >&2\nexit 1\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${f.base}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  await assert.rejects(fetchGitHubAsset({ github: { repository: 'example/product', tag: `worker-${'a'.repeat(40)}` },
    asset: 'artifact.tar.gz', destination: join(f.base, 'download.tar.gz'), maxBytes: 1024,
  }), error => {
    assert.equal(error.code, 'worker_update_github_unavailable');
    assert.match(error.message, /release asset not found/);
    return true;
  });
});

test('supervisor readiness failure captures startup stderr before rollback', async t => {
  const f = await fixture(t);
  const updater = await new WorkerUpdater(f.options).initialize();
  t.after(() => updater.close());
  await updater.start();
  let readinessChecks = 0;
  let logReads = 0;
  await superviseWorkerUpdate(await readUpdateRecord(f.stateDirectory), {
    prepareService: async () => {}, switchPointer: async () => {}, restart: async () => {},
    ready: async () => { if (++readinessChecks === 1) throw new WorkerError('worker_update_startup_timeout'); },
    readStartupFailure: async () => { logReads++; return 'Cannot find module startup-helper'; },
  });
  assert.equal(logReads, 1);
  const status = (await readUpdateRecord(f.stateDirectory)).status;
  assert.equal(status.state, 'rolled-back');
  assert.match(status.lastError, /Cannot find module startup-helper/);
});
