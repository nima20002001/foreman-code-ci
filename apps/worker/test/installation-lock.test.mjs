import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withInstallLock } from '../src/installation.mjs';

async function fixture(t) {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'worker-install-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('installation excludes concurrent processes and recovers automatically after SIGKILL', async t => {
  const root = await fixture(t);
  const module = new URL('../src/installation.mjs', import.meta.url).href;
  const script = `import { withInstallLock } from ${JSON.stringify(module)};
    await withInstallLock(process.argv[1], async () => {
      process.send('locked');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, root],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  });
  const started = await Promise.race([
    once(child, 'message'),
    once(child, 'exit').then(([code]) => { throw new Error(`Installer exited before locking (${code}).`); }),
  ]);
  assert.equal(started[0], 'locked');
  await assert.rejects(withInstallLock(root, async () => assert.fail('Concurrent installer entered.')),
    { code: 'install_busy' });
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  assert.equal(await withInstallLock(root, async () => 'recovered'), 'recovered');
});

test('installation releases its lock after a rejected operation', async t => {
  const root = await fixture(t);
  const failure = new Error('staging failed');
  await assert.rejects(withInstallLock(root, async () => { throw failure; }), failure);
  assert.equal(await withInstallLock(root, async () => 'retried'), 'retried');
});
