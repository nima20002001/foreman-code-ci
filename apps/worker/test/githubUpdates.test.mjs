import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { WorkerUpdater, downloadWorkerArtifact } from '../src/update.mjs';
import { WorkerError } from '../src/diagnostics.mjs';

const facts = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.2',
  rootPersistent: true, homePersistent: true, storagePersistent: true };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'github-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('export const worker = true;\n');
  const { os, osRelease, arch, libc, node } = facts;
  const manifest = { format: 1, version: '1.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1,
    target: { os, osRelease, arch, libc, node },
    files: [{ path: 'src/cli.mjs', sha256: hash(bytes), size: bytes.length }] };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const release = { version: manifest.version, manifest, manifestSha256: hash(manifestBytes),
    github: { repository: 'example/worker', tag: `worker-${manifest.commit}` } };
  const requests = [];
  const request = async payload => {
    requests.push(payload.operation);
    if (payload.operation === 'release') return { payload: { operation: 'release', release } };
    if (payload.operation === 'ci-smoke') return { payload: { operation: 'ci-smoke', ciSmoke: null } };
    throw new Error(`Unexpected Main request: ${payload.operation}`);
  };
  return { directory, release, request, requests };
}

test('missing GitHub assets fail visibly without requesting any bundle bytes from Main', async t => {
  const f = await fixture(t);
  const stateDirectory = join(f.directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const binaries = join(f.directory, 'bin');
  await mkdir(binaries);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(binaries, 'gh'), '#!/bin/sh\necho "release not found" >&2\nexit 1\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${binaries}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });
  const updater = await new WorkerUpdater({
    stateDirectory, version: '1.0.0', manifestSha256: 'c'.repeat(64), facts,
    assertStateOwnership: () => {}, connection: () => ({ captureRequest: () => ({ request: f.request }) }),
    downloadTimeoutMs: 80, drain: async () => {}, resume: () => {},
    locateLaunch: async () => ({ root: f.directory }), stage: async () => ({ directory: f.directory }),
    launchSupervisor: async () => {},
  }).initialize();
  t.after(() => updater.close());
  const result = await updater.start().catch(error => error);
  assert.equal(result.code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
  assert.deepEqual(f.requests, ['release']);
  const status = await updater.status();
  assert.equal(status.state, 'failed');
  assert.match(status.lastError, /WORKER_RELEASE_ASSET_UNAVAILABLE/);
  assert.match(status.lastError, /release not found/);
  assert.equal(status.currentVersion, '1.0.0');
});

test('release metadata without GitHub location cannot select Main as a download source', async t => {
  const f = await fixture(t);
  delete f.release.github;
  await assert.rejects(downloadWorkerArtifact({ release: f.release, facts, directory: join(f.directory, 'download'),
    request: f.request, timeoutMs: 80 }), { code: 'WORKER_RELEASE_ASSET_UNAVAILABLE' });
  assert.deepEqual(f.requests, []);
});

test('GitHub retries back off and retain the last GitHub reason when the deadline expires', async t => {
  const f = await fixture(t);
  const waits = [];
  const scheduleTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds >= 5000 && milliseconds <= 60000) {
      waits.push(milliseconds);
      return scheduleTimeout(callback, 1, ...args);
    }
    return scheduleTimeout(callback, milliseconds, ...args);
  });
  let attempts = 0;
  await assert.rejects(downloadWorkerArtifact({ release: f.release, facts, directory: join(f.directory, 'download'),
    request: f.request, timeoutMs: 80,
    fetchAsset: async () => { attempts++; throw new WorkerError('worker_update_github_unavailable', 'asset missing'); },
  }), error => {
    assert.equal(error.code, 'WORKER_RELEASE_ASSET_UNAVAILABLE');
    assert.match(error.message, /asset missing/);
    return true;
  });
  assert.ok(attempts >= 3);
  assert.ok(waits[1] > waits[0]);
  assert.deepEqual(f.requests, []);
});
