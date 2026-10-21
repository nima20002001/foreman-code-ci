import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readlink, readdir, rm, symlink } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { installVersion, readInstalledRelease, readRetainedRelease, rollbackVersion, stageRunningVersion }
  from '../src/installation.mjs';
import { superviseWorkerUpdate, writeUpdateRecord } from '../src/updateSupervisor.mjs';
import { recordPersistence } from './fixtures/persistentFilesystem.mjs';
import { WORKER_UPDATE_ATTEMPT_TIMEOUT_MS } from '@foreman-code/contracts/worker-update';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const facts = {
  os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true,
};
const expected = { protocolVersion: 1, identityFormat: 1 };

const bundleFiles = ['src/cli.mjs', 'src/nested/driver.mjs', 'artifacts/runtime/deep/config.json',
  'dependencies/@scope/runtime/index.mjs'];
const [entryFile] = bundleFiles;

async function artifact(directory, version) {
  const files = [];
  for (const path of bundleFiles) {
    const bytes = `${version}: ${path}\n`;
    await mkdir(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(directory, path), bytes);
    files.push({ path, size: Buffer.byteLength(bytes), sha256: hash(bytes) });
  }
  const manifest = {
    format: 1, version, protocolVersion: 1, identityFormat: 1, commit: 'a'.repeat(40),
    lockfileSha256: 'b'.repeat(64), packageManager: 'pnpm@11.27.0', target: facts, files,
  };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(directory, 'manifest.json'), bytes);
  return { artifact: directory, approvedManifestSha256: hash(bytes) };
}

async function fixture(t) {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'worker-persistence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'app');
  const stateDirectory = join(directory, 'state');
  await mkdir(root, { mode: 0o700 });
  await mkdir(stateDirectory, { mode: 0o700 });
  return { directory, root, stateDirectory, facts, expected };
}

async function assertFiles(release) {
  for (const file of release.manifest.files) {
    const bytes = await readFile(join(release.directory, file.path));
    assert.equal(bytes.length, file.size);
    assert.equal(hash(bytes), file.sha256);
  }
}

async function retained(root) {
  try {
    await readlink(join(root, 'previous'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  const release = await readRetainedRelease(root);
  await assertFiles(release);
  return release;
}

async function hasCurrent(root) {
  try {
    await readlink(join(root, 'current'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

for (const updating of [false, true]) {
  test(`power cuts at every install boundary preserve complete nested releases (update: ${updating})`,
    async t => {
      const f = await fixture(t);
      if (updating) {
        await installVersion({ ...f, ...await artifact(join(f.directory, 'retained'), '0.9.0') });
        await installVersion({ ...f, ...await artifact(join(f.directory, 'first'), '1.0.0'),
          updatePolicy: async () => true });
      }
      const incoming = await artifact(join(f.directory, 'incoming'), '1.1.0');
      const recording = await recordPersistence(t, f.root);
      try {
        await installVersion({ ...f, ...incoming, updatePolicy: async () => true });
      } finally {
        recording.stop();
      }
      assert(recording.snapshots.some(snapshot => snapshot.label.includes('rename current')));
      for (const snapshot of recording.snapshots) {
        await t.test(snapshot.label, async () => {
          await recording.reboot(snapshot);
          const published = await hasCurrent(f.root);
          if (updating) assert(published);
          if (published) {
            const current = await readInstalledRelease(f);
            await assertFiles(current);
            assert(['1.0.0', '1.1.0'].includes(current.manifest.version),
              `Unexpected current version ${current.manifest.version} at ${snapshot.label}`);
            if (snapshot === recording.snapshots.at(-1)) assert.equal(current.manifest.version, '1.1.0');
          }
          const previous = await retained(f.root);
          if (previous) {
            assert(['0.9.0', '1.0.0'].includes(previous.manifest.version));
            // Remove only the simulated, known-dead installer lock in this owned fixture.
            await rm(join(f.root, '.install-lock'), { recursive: true, force: true });
            await rollbackVersion({ ...f, approveStop: async () => true });
            assert.equal((await readInstalledRelease(f)).manifest.version, previous.manifest.version);
          }
          await rm(join(f.root, '.install-lock'), { recursive: true, force: true });
          await installVersion({ ...f, ...incoming, updatePolicy: async () => true });
          const recovered = await readInstalledRelease(f);
          assert.equal(recovered.manifest.version, '1.1.0');
          await assertFiles(recovered);
        });
      }
    });
}

test('power-cut snapshots preserve an updated current when a removed symlink inode is reused', async t => {
  const f = await fixture(t);
  await installVersion({ ...f, ...await artifact(join(f.directory, 'retained'), '0.9.0') });
  await installVersion({ ...f, ...await artifact(join(f.directory, 'first'), '1.0.0'),
    updatePolicy: async () => true });
  const incoming = await artifact(join(f.directory, 'incoming'), '1.1.0');
  const incomingTarget = `versions/1.1.0-${incoming.approvedManifestSha256}`;
  const replaced = await fs.lstat(join(f.root, 'previous'));
  const lstat = fs.lstat;
  const mocked = t.mock.method(fs, 'lstat', async (path, ...args) => {
    const info = await lstat(path, ...args);
    if (path === join(f.root, 'current') && await readlink(path) === incomingTarget) {
      info.ino = replaced.ino;
    }
    return info;
  });
  const recording = await recordPersistence(t, f.root);
  try {
    await installVersion({ ...f, ...incoming, updatePolicy: async () => true });
  } finally {
    recording.stop();
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  await recording.reboot(recording.snapshots.at(-1));
  const current = await readInstalledRelease(f);
  assert.equal(current.manifest.version, '1.1.0');
  await assertFiles(current);
  const previous = await readRetainedRelease(f.root);
  assert.equal(previous.manifest.version, '1.0.0');
  await assertFiles(previous);
});

test('creating nested installation roots persists the root before publishing current', async t => {
  const f = await fixture(t);
  const incoming = await artifact(join(f.directory, 'incoming'), '1.0.0');
  const recording = await recordPersistence(t, f.directory);
  const root = join(f.directory, 'new-parent', 'nested', 'app');
  try {
    await installVersion({ ...f, root, ...incoming });
  } finally {
    recording.stop();
  }
  await recording.reboot(recording.snapshots.at(-1));
  await assertFiles(await readInstalledRelease({ ...f, root }));
});

for (const directory of ['src/nested', 'artifacts/runtime/deep', 'dependencies/@scope/runtime']) {
  test(`a sync failure in ${directory} rejects the update before publication and permits retry`, async t => {
    const f = await fixture(t);
    await installVersion({ ...f, ...await artifact(join(f.directory, 'first'), '1.0.0') });
    const first = await readlink(join(f.root, 'current'));
    const incoming = await artifact(join(f.directory, 'incoming'), '1.1.0');
    const open = fs.open;
    const fault = Object.assign(new Error('Injected directory sync failure'), { code: 'EIO' });
    const mocked = t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args);
      if (typeof path === 'string' && path.includes('/.stage-') && path.endsWith(`/${directory}`)) {
        handle.sync = async () => { throw fault; };
      }
      return handle;
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(installVersion({ ...f, ...incoming, updatePolicy: async () => true }), fault);
      assert.equal(await readlink(join(f.root, 'current')), first);
      await assertFiles(await readInstalledRelease(f));
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    await installVersion({ ...f, ...incoming, updatePolicy: async () => true });
    await assertFiles(await readInstalledRelease(f));
    await assertFiles(await readRetainedRelease(f.root));
  });
}


async function installSequence(f, versions) {
  const installed = [];
  for (const version of versions) {
    installed.push(await installVersion({ ...f,
      ...await artifact(join(f.directory, `artifact-${version}`), version), updatePolicy: async () => true }));
  }
  return installed;
}

test('successful updates remove obsolete versions and preserve rollback', async t => {
  const f = await fixture(t);
  const releases = await installSequence(f, ['1.0.0', '1.1.0', '1.2.0', '1.3.0']);
  assert.deepEqual((await readdir(join(f.root, 'versions'))).sort(),
    releases.slice(-2).map(release => release.directory.split('/').at(-1)).sort());
  await rollbackVersion({ ...f, approveStop: async () => true });
  assert.equal((await readInstalledRelease(f)).manifest.version, '1.2.0');
});

test('updates preserve releases referenced by the update record until its references change', async t => {
  const f = await fixture(t);
  const [first, second] = await installSequence(f, ['1.0.0', '1.1.0']);
  await writeFile(join(f.stateDirectory, 'worker-update.json'), JSON.stringify({ format: 1,
    restart: { directory: first.directory, previousDirectory: second.directory } }), { mode: 0o600 });
  const later = await installSequence(f, ['1.2.0', '1.3.0']);
  assert.equal((await readdir(join(f.root, 'versions'))).length, 4);
  await writeFile(join(f.stateDirectory, 'worker-update.json'), JSON.stringify({ format: 1,
    restart: { directory: later[1].directory, previousDirectory: later[0].directory } }), { mode: 0o600 });
  await installSequence(f, ['1.4.0']);
  assert.deepEqual((await readdir(join(f.root, 'versions'))).sort(),
    [...later.map(release => release.directory.split('/').at(-1)),
      (await readlink(join(f.root, 'current'))).split('/').at(-1)].sort());
});

test('an unsuccessful publication preserves obsolete versions for retry', async t => {
  const f = await fixture(t);
  const [first] = await installSequence(f, ['1.0.0', '1.1.0']);
  const fault = new Error('Publication failed');
  await assert.rejects(installVersion({ ...f,
    ...await artifact(join(f.directory, 'incoming'), '1.2.0'), updatePolicy: async () => true,
    publishInstallation: async () => { throw fault; } }), fault);
  assert.equal(await readFile(join(first.directory, entryFile), 'utf8'), `1.0.0: ${entryFile}\n`);
});


test('supervised updates prune after readiness and leave staged releases intact before handoff', async t => {
  const f = await fixture(t);
  const [first] = await installSequence(f, ['1.0.0']);
  let previous = first;
  for (const version of ['1.1.0', '1.2.0']) {
    const staged = await stageRunningVersion({ ...f,
      ...await artifact(join(f.directory, `artifact-${version}`), version),
      assertStateOwnership: () => {}, updatePolicy: async () => true });
    assert.equal(await readFile(join(staged.directory, entryFile), 'utf8'), `${version}: ${entryFile}\n`);
    assert.equal((await readInstalledRelease(f)).manifest.version, previous.version);
    const beforeReadiness = (await readdir(join(f.root, 'versions'))).sort();
    const record = { format: 1, manifestSha256: staged.manifestSha256,
      attemptDeadlineAt: Date.now() + WORKER_UPDATE_ATTEMPT_TIMEOUT_MS,
      status: { state: 'restarting', targetVersion: version, currentVersion: previous.version,
        manifestSha256: previous.manifestSha256 },
      restart: { service: 'graphql-worker.service', root: f.root, stateDirectory: f.stateDirectory,
        directory: staged.directory, previousDirectory: previous.directory, previousVersion: previous.version,
        requestId: `update-${version}`, pointer: { kind: 'symlink', path: join(f.root, 'current') } } };
    await writeUpdateRecord(f.stateDirectory, record);
    await superviseWorkerUpdate(record, { prepareService: async () => {}, restart: async () => {},
      ready: async () => {
        assert.equal((await readInstalledRelease(f)).manifest.version, version);
        assert.deepEqual((await readdir(join(f.root, 'versions'))).sort(), beforeReadiness);
      }, smoke: async () => {} });
    assert.equal(record.status.state, 'current');
    assert.equal(record.status.lastError, null);
    previous = staged;
  }
  assert.equal((await readdir(join(f.root, 'versions'))).length, 2);
  assert.equal((await readInstalledRelease(f)).manifest.version, '1.2.0');
  assert.equal((await readRetainedRelease(f.root)).manifest.version, '1.1.0');
});


for (const rootKind of ['canonical', 'symlink']) {
  test(`pruning keeps the selected SDK release until startup moves its selection (${rootKind})`, async t => {
    const f = await fixture(t);
    if (rootKind === 'symlink') {
      const alias = join(f.directory, 'installation-alias');
      await symlink('.', alias);
      f.root = join(alias, 'app');
    }
    const [first] = await installSequence(f, ['1.0.0', '1.1.0']);
    const path = join(f.stateDirectory, 'workflow-runtime.json');
    const selection = release => ({ schemaVersion: 1,
      appMcpLauncher: join(release.directory, 'artifacts/graphql-mcp.mjs'),
      claude: { binary: '/selected/claude',
        sdkEntrypoint: join(release.directory, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
        installedLockPath: join(release.directory, 'artifacts/claude-sdk-lock.yaml') } });
    await writeFile(path, JSON.stringify(selection(first)), { mode: 0o600 });
    const [third] = await installSequence(f, ['1.2.0']);
    assert.equal(await readFile(join(first.directory, entryFile), 'utf8'), `1.0.0: ${entryFile}\n`);
    await writeFile(path, JSON.stringify(selection(third)), { mode: 0o600 });
    await installSequence(f, ['1.3.0']);
    await assert.rejects(readFile(join(first.directory, entryFile)), { code: 'ENOENT' });
    assert.equal((await readdir(join(f.root, 'versions'))).length, 2);
  });
}
