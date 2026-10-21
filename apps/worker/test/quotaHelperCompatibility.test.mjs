import { nativeWorkerTarget } from './fixtures/browserTarget.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { inspectQuotaHelperAbi } from '../../../scripts/quota-helper-abi.mjs';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const targets = [
  'test-hosts/ubuntu-24.04-x64-target.json', 'ubuntu-26.04-x64-target.json',
  'test-hosts/ubuntu-24.04-x64-node-22.23.2-target.json', 'test-hosts/ubuntu-26.04-x64-node-22.23.2-target.json',
];

const containers = await mkdtemp(join(persistentFixtureRoot, 'qhc-'));
// Podman's runtime path has a 50-character limit; keep image layers on persistent storage.
const runtimeParent = join(homedir(), '.cache', 'foreman-tmp');
await mkdir(runtimeParent, { recursive: true, mode: 0o700 });
const runtime = await mkdtemp(join(runtimeParent, 'q-'));
const native = await nativeWorkerTarget(repository);
const storage = ['--root', join(containers, 'storage'), '--runroot', runtime];
const podman = (args, timeout = 60_000) => spawnSync('podman', [...storage, ...args], {
  encoding: 'utf8', timeout,
});
const images = new Set();
after(async () => {
  // Rootless image layers can belong to subordinate UIDs; Podman removes its own store.
  const cleanup = podman(['system', 'reset', '--force']);
  assert.ifError(cleanup.error);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  await rm(containers, { recursive: true, force: true });
  await rm(runtime, { recursive: true, force: true });
});

for (const name of targets) {
  test(`the released quota observer loads on ${name}`, { timeout: 180_000 }, async t => {
    const directory = await mkdtemp(join(containers, 'release-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'release');
    const build = spawnSync(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'),
      native.file, output], { cwd: repository, encoding: 'utf8', timeout: 120_000 });
    assert.ifError(build.error);
    assert.equal(build.status, 0, build.stderr);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    const helper = join(output, 'artifacts/job-quota-query');
    const target = JSON.parse(await readFile(join(repository, 'apps/worker/artifacts', name), 'utf8'));
    const requirements = await inspectQuotaHelperAbi(helper, target);
    t.diagnostic(JSON.stringify({ buildTarget: manifest.target, testedTarget: target, requirements }));
    const image = `docker.io/library/ubuntu:${target.osRelease}`;
    if (!images.has(image)) {
      const pull = podman(['pull', image], 120_000);
      assert.ifError(pull.error);
      assert.equal(pull.status, 0, pull.stderr);
      images.add(image);
    }
    const libc = podman(['run', '--pull=never', '--rm', '--network=none', '--read-only', '--cap-drop=all',
      image, 'getconf', 'GNU_LIBC_VERSION']);
    assert.ifError(libc.error);
    assert.equal(libc.status, 0, libc.stderr);
    assert.equal(libc.stdout.trim().replace('glibc ', 'glibc-'), target.libc);
    const probe = podman(['run', '--pull=never', '--rm', '--network=none', '--read-only', '--cap-drop=all',
      '--env', 'LD_BIND_NOW=1', '--volume', `${helper}:/observer:ro`, image,
      '/observer']);
    assert.ifError(probe.error);
    // With no paths the read-only observer exits before filesystem or quota access.
    assert.equal(probe.status, 2, probe.stderr);
    assert.equal(probe.stdout, '');
    assert.equal(probe.stderr, '');
  });
}
