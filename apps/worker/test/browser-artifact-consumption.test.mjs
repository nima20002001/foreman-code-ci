import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('core Worker assembly reports unavailable browser artifacts without building a browser on Main', async t => {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'worker-core-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const output = join(directory, 'artifact');
  const environment = { ...process.env };
  delete environment.FOREMAN_CODE_BROWSER_RUNTIME_ARTIFACTS;
  execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs',
    'apps/worker/artifacts/ubuntu-26.04-x64-target.json', output],
  { cwd: repository, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browserRuntimeStatus.state, 'failed');
  assert.equal(manifest.browserRuntimeStatus.retryable, true);
  assert.match(manifest.browserRuntimeStatus.reason, /matching.*runner/i);
  assert.equal(manifest.browserRuntime, undefined);
  assert.ok(manifest.files.some(file => file.path === 'src/cli.mjs'));
});
