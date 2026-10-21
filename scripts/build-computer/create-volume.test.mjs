import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistentFixtureRoot } from '../../apps/worker/test/fixtureStorage.mjs';

const createVolume = fileURLToPath(new URL('./create-volume.sh', import.meta.url));
const environment = { ...process.env, PATH: `/usr/sbin:/sbin:${process.env.PATH}` };

async function fixture(t) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'build-volume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'volume.ext4');
}

test('creating a quota volume preserves its finite size while allocating only filesystem metadata', async t => {
  const backing = await fixture(t);
  execFileSync('/bin/sh', [createVolume, backing, '64M'], {
    env: environment, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const details = await stat(backing);
  assert.equal(details.size, 64 * 2 ** 20);
  assert.ok(details.blocks * 512 > 0);
  assert.ok(details.blocks * 512 < details.size / 2,
    `${details.blocks * 512} of ${details.size} backing bytes were allocated`);
  const filesystem = execFileSync('dumpe2fs', ['-h', backing], {
    env: environment, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const features = /^Filesystem features:\s+(.+)$/m.exec(filesystem)?.[1].split(/\s+/);
  assert.ok(features?.includes('quota'));
  assert.ok(features?.includes('project'));
});

test('volume creation refuses an existing backing file without changing its bytes', async t => {
  const backing = await fixture(t);
  await writeFile(backing, 'retained backing bytes', { mode: 0o600 });
  const result = spawnSync('/bin/sh', [createVolume, backing, '64M'], {
    env: environment, encoding: 'utf8', timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(backing, 'utf8'), 'retained backing bytes');
});
