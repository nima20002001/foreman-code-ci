import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('both CLIs provide static model-free help before argument, filesystem and runtime checks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-help-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'src'); await mkdir(source);
  // No manifest, contracts, enrollment or worker factory is present in this copy.
  for (const name of ['cli.mjs', 'install-cli.mjs', 'diagnostics.mjs', 'runtime.mjs', 'installation.mjs', 'service.mjs', 'companionLauncher.mjs']) {
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(source, name));
  }
  const before = await readdir(directory);
  for (const entry of ['cli.mjs', 'install-cli.mjs']) {
    for (const args of [[], ['--help'], ['-h'], ['pair', '--state', '/missing/private/state', '--broken', '--help']]) {
      const result = spawnSync(process.execPath, [join(source, entry), ...args], { encoding: 'utf8', timeout: 5000,
        env: { PATH: '', HOME: '/missing/home' } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /install --root \/private\/app --state \/private\/state --artifact/);
      assert.match(result.stdout, /Update:/);
      assert.match(result.stdout, /rollback --root \/private\/app --state \/private\/state --approve-stopped-update yes/);
      assert.match(result.stdout, /drain\/stop policy and stop the worker service/);
      assert.match(result.stdout, /active worker blocks replacement/i);
      if (entry === 'cli.mjs') {
        assert.match(result.stdout, /capture-job-runtime --state .* --input/);
        assert.match(result.stdout, /never qualifies or launches a Job/);
      }
    }
  }
  assert.deepEqual(await readdir(directory), before);
});
