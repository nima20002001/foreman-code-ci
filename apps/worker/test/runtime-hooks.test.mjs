import { persistentFixtureRoot } from './fixtureStorage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startWorker, acquireWorkerLock } from '../src/runtime.mjs';

const runtimeUrl = new URL('../src/runtime.mjs', import.meta.url).href;
async function state(t) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-drain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const connection = () => ({ start: async () => {}, stop: async () => {} });

test('journal recovery ownership is available only while the original Worker state socket is held', async t => {
  const stateDirectory = await state(t);
  let assertStateOwnership;
  const worker = await startWorker({ stateDirectory, loadIdentity: async () => ({}),
    createConnection: async input => {
      assertStateOwnership = input.assertStateOwnership;
      assertStateOwnership();
      await assert.rejects(acquireWorkerLock(stateDirectory), /worker_already_running/);
      return connection();
    } });
  await worker.stop();
  assert.throws(assertStateOwnership, /worker_ownership_lost/);
});

test('worker retains its actual lock until transport and domain drain finish', async t => {
  const stateDirectory = await state(t), events = [];
  let finish, entered, timer;
  const pending = new Promise(resolve => { finish = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const worker = await startWorker({ stateDirectory, loadIdentity: async () => ({}),
    createConnection: async () => ({ ...connection(), stop: async () => { events.push('transport'); } }),
    beforeUnlock: async () => { events.push('domain'); entered(); await pending; } });
  const stopping = worker.stop();
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Domain drain was not invoked')), 1000); })]);
    clearTimeout(timer);
    assert.deepEqual(events, ['transport', 'domain']);
    await assert.rejects(acquireWorkerLock(stateDirectory), /worker_already_running/);
  } finally { clearTimeout(timer); finish(); await stopping; }
  await worker.stop();
  assert.deepEqual(events, ['transport', 'domain']);
  const unlock = await acquireWorkerLock(stateDirectory); await unlock();
});

test('startup failure drains created domains before making the lock available', async t => {
  const stateDirectory = await state(t), events = [];
  await assert.rejects(startWorker({ stateDirectory, loadIdentity: async () => ({}),
    createConnection: async () => ({ start: async () => { throw new Error('connection start failed'); }, stop: async () => { events.push('transport'); } }),
    beforeUnlock: async () => { events.push('domain'); await assert.rejects(acquireWorkerLock(stateDirectory), /worker_already_running/); } }), /connection start failed/);
  assert.deepEqual(events, ['transport', 'domain']);
  const unlock = await acquireWorkerLock(stateDirectory); await unlock();
});

for (const mode of ['failure', 'timeout', 'startup-failure']) test(`worker retains its original lock after ${mode}`, async t => {
  const stateDirectory = await state(t);
  const script = `import assert from 'node:assert/strict';
    const { startWorker, acquireWorkerLock } = await import(process.argv[1]);
    const stateDirectory = process.argv[2], mode = process.argv[3];
    let finish, drained; const drainFinished = new Promise(resolve => { drained = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const options = { stateDirectory, loadIdentity: async () => ({}), shutdownMs: 20,
      createConnection: async () => ({ start: async () => { if (mode === 'startup-failure') throw new Error('connection start failed'); }, stop: async () => {} }),
      beforeUnlock: async () => {
        try { if (mode === 'timeout') await pending; else throw new Error('domain drain failed'); }
        finally { drained(); }
      } };
    if (mode === 'startup-failure') await assert.rejects(startWorker(options), error => error instanceof AggregateError && error.errors.length === 2);
    else { const worker = await startWorker(options); await assert.rejects(worker.stop(), mode === 'timeout' ? /shutdown_timeout/ : /domain drain failed/); }
    finish(); await drainFinished;
    await assert.rejects(acquireWorkerLock(stateDirectory), /worker_already_running/);
    process.exit(0);`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script, runtimeUrl, stateDirectory, mode], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
