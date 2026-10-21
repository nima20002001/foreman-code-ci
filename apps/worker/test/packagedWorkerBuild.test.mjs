import { browserHostTarget, matchesBrowserTarget, nativeWorkerTarget } from './fixtures/browserTarget.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

const native = await nativeWorkerTarget(repository);
const host = await browserHostTarget();
const candidates = [
  { runtime: native.target.node.slice(1), target: native.file },
  { runtime: '22.23.3', target: 'apps/worker/artifacts/ubuntu-26.04-x64-target.json' },
  { runtime: '22.23.2', target: 'apps/worker/artifacts/test-hosts/ubuntu-26.04-x64-node-22.23.2-target.json' },
];
for (const { runtime, target } of candidates.filter((candidate, index) => candidates.findIndex(value => value.target === candidate.target) === index)) {
  const expected = JSON.parse(await readFile(join(repository, target), 'utf8'));
  test(`the committed worker package builds and loads its complete execution graph on ${expected.os} ${expected.osRelease} with Node ${runtime}`, async t => {
    if (!matchesBrowserTarget(host, expected)) {
      t.skip(`Requires native ${JSON.stringify(expected)}; this runner is ${JSON.stringify(host)}`);
      return;
    }
    const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-build-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'release');
    execFileSync(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'),
      target, output,
      ...(runtime === '22.23.3' ? ['apps/worker/artifacts/node-22.23.3-linux-x64.json'] : [])],
    { cwd: join(repository, 'apps/worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    const product = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    assert.equal(manifest.version, product.version);
    assert.equal(manifest.target.node, `v${runtime}`);
    assert.deepEqual(manifest.target, host);
    const { createWorkerConnection } = await import(pathToFileURL(join(output, 'src/worker.mjs')).href);
    const connection = createWorkerConnection({
      pairing: {
        mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
        keyRevision: 1, authorizationRevision: 1,
        endpoint: 'wss://worker-build.example/device/connect',
        credential: 'a'.repeat(64), mainPublicKeyFingerprint: 'b'.repeat(64),
      },
      bootId: randomUUID(), appVersion: '0.1.0', extensions: [],
    });
    assert.equal(connection.status().phase, 'disconnected');
    await connection.stop();
  });
}
