import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, statfs, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { persistentFixtureRoot } from './fixtureStorage.mjs';

test('persistent fixtures use executable private scratch and retain real filesystem classification', async t => {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'fixture-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.ok(directory.startsWith(`${persistentFixtureRoot}/`));
  assert.notEqual((await statfs(directory)).type, 0x01021994);
  const path = join(directory, 'record');
  await writeFile(path, 'private fixture', { mode: 0o600 });
  assert.equal(await readFile(path, 'utf8'), 'private fixture');
});
