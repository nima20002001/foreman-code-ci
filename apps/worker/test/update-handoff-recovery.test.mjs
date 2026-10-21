import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { WorkerUpdater } from '../src/update.mjs';
import { WorkerError } from '../src/diagnostics.mjs';
import { launchUpdateSupervisor, readUpdateRecord, recoverPendingWorkerUpdate, writeUpdateRecord }
  from '../src/updateSupervisor.mjs';

async function fixture(t) {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const stateDirectory = await mkdtemp(join(parent, 'worker-handoff-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const record = { format: 1, manifestSha256: 'b'.repeat(64),
    status: { state: 'restarting', currentVersion: '1.0.0', targetVersion: '1.1.0',
      manifestSha256: 'a'.repeat(64), lastError: null },
    restart: { stateDirectory, unit: `foreman-worker-update-${randomUUID()}`,
      requestId: randomUUID(), restartAttempted: false } };
  await writeUpdateRecord(stateDirectory, record);
  return { stateDirectory, record };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await wait(5);
  }
  assert.fail('The running Worker did not reconcile its pending handoff.');
}

test('periodic checks retry a helper that never appeared, without reopening work or changing its unit', async t => {
  const f = await fixture(t);
  let launches = 0;
  let probes = 0;
  let helperActive = false;
  let resumed = 0;
  const units = [];
  const run = async (_binary, args) => {
    if (args.includes('--property=ActiveState')) {
      probes++;
      return { stdout: helperActive ? 'active\n' : 'inactive\n' };
    }
    units.push(args[args.indexOf('--unit') + 1]);
    if (++launches === 1) {
      throw Object.assign(new Error('Launch timed out before creating a helper.'), { killed: true, signal: 'SIGTERM' });
    }
    helperActive = true;
    const record = await readUpdateRecord(f.stateDirectory);
    record.supervisorStarted = record.restart.requestId;
    await writeUpdateRecord(f.stateDirectory, record);
    return { stdout: '' };
  };
  await assert.rejects(launchUpdateSupervisor(f.stateDirectory, { run }),
    { code: 'worker_update_supervisor_handoff_pending' });
  const errors = [];
  const updater = await new WorkerUpdater({ stateDirectory: f.stateDirectory,
    version: '1.0.0', manifestSha256: 'a'.repeat(64), assertStateOwnership: () => {},
    resume: () => { resumed++; }, reportError: error => { errors.push(error); }, checkIntervalMs: 10,
    recoverSupervisor: (stateDirectory, options) => recoverPendingWorkerUpdate(stateDirectory, {
      ...options, run, launch: directory => launchUpdateSupervisor(directory, { run }),
    }),
  }).initialize();
  t.after(() => updater.close());
  updater.ready();
  await until(async () => probes >= 2 && (await readUpdateRecord(f.stateDirectory)).supervisorStarted);
  assert.equal(launches, 2);
  assert.equal(units[0], units[1]);
  assert.equal(resumed, 0);
  assert.deepEqual(errors, []);
  assert.equal((await updater.status()).state, 'restarting');
  await assert.rejects(updater.start({ retry: true }), { code: 'worker_update_restart_pending' });
});

for (const state of ['active', 'activating', 'reloading', 'deactivating', 'maintenance']) {
  test(`reconciliation leaves a ${state} helper in sole control of restarting`, async t => {
    const f = await fixture(t);
    let launches = 0;
    await recoverPendingWorkerUpdate(f.stateDirectory, {
      run: async () => ({ stdout: `${state}\n` }),
      launch: async () => { launches++; },
    });
    assert.equal(launches, 0);
    assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'restarting');
  });
}

test('periodic reconciliation is serialized and shutdown waits for it without launching another helper', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let probes = 0;
  let launches = 0;
  const updater = await new WorkerUpdater({ stateDirectory: f.stateDirectory,
    version: '1.0.0', manifestSha256: 'a'.repeat(64), assertStateOwnership: () => {},
    checkIntervalMs: 10, reportError: error => { assert.equal(error.code, 'worker_updater_stopped'); },
    recoverSupervisor: (stateDirectory, options) => recoverPendingWorkerUpdate(stateDirectory, {
      ...options, run: async () => { probes++; await gate; return { stdout: 'inactive\n' }; },
      launch: async () => { launches++; },
    }),
  }).initialize();
  t.after(() => updater.close());
  updater.ready();
  try {
    await until(() => probes === 1);
    updater.ready();
    updater.ready();
    let closed = false;
    const closing = updater.close().then(() => { closed = true; });
    await wait(20);
    assert.equal(closed, false);
    release();
    await closing;
    assert.equal(probes, 1);
    assert.equal(launches, 0);
  } finally { release(); }
});

test('an uncertain helper probe stays unresolved for a later check', async t => {
  const f = await fixture(t);
  let launches = 0;
  const failure = new WorkerError('worker_status_timeout');
  await assert.rejects(recoverPendingWorkerUpdate(f.stateDirectory, {
    run: async () => { throw failure; }, launch: async () => { launches++; },
  }), failure);
  assert.equal(launches, 0);
  assert.equal((await readUpdateRecord(f.stateDirectory)).status.state, 'restarting');
});
