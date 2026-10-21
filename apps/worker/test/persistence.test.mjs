import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostFacts } from '../src/diagnostics.mjs';

test('HOME and state persistence follow existing ancestor aliases into ephemeral storage', async (t) => {
  const directory = await mkdtemp('/dev/shm/worker-persistence-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'private'), { mode: 0o700 });
  const physical = await realpath(directory);
  const alias = `/proc/self/root${physical}`;
  const expected = await hostFacts(physical, [join(physical, 'private')]);
  assert.equal(expected.homePersistent, false, 'regression fixture must use ephemeral storage');
  assert.equal(expected.storagePersistent, false);
  const existing = await hostFacts(alias, [join(alias, 'private')]);
  assert.equal(existing.homePersistent, false);
  assert.equal(existing.storagePersistent, false);
  const future = await hostFacts(join(alias, 'new-home'), [join(alias, 'new-app', 'state')]);
  assert.equal(future.homePersistent, false);
  assert.equal(future.storagePersistent, false);
});

test('unavailable physical storage proof fails closed for a dangling ancestor symlink', async (t) => {
  const directory = await mkdtemp('/dev/shm/worker-persistence-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const alias = join(directory, 'dangling');
  await symlink('/worker-storage-target-that-does-not-exist', alias);
  const unresolved = `/proc/self/root${await realpath(directory)}/dangling`;
  const facts = await hostFacts(join(unresolved, 'home'), [join(unresolved, 'state')]);
  assert.equal(facts.homePersistent, false);
  assert.equal(facts.storagePersistent, false);
});

test('new directories retain the persistence of their real existing ancestor', async () => {
  const physical = await realpath(process.cwd());
  const expected = await hostFacts(physical, [physical]);
  const alias = `/proc/self/root${physical}`;
  const facts = await hostFacts(join(alias, 'new-home'), [join(alias, 'new-app', 'state')]);
  assert.equal(facts.homePersistent, expected.homePersistent);
  assert.equal(facts.storagePersistent, expected.storagePersistent);
});
