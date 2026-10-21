import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForWorkerReady } from '../src/updateSupervisor.mjs';
import { WorkerError } from '../src/diagnostics.mjs';

const ready = { active: true, phase: 'ready', appVersion: '1.1.0', workerInstallationId: 'installation' };
const options = { stateDirectory: '/fixture/state', version: ready.appVersion,
  workerInstallationId: ready.workerInstallationId, timeoutMs: 100, pollMs: 1 };

for (const code of ['worker_status_timeout', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
  test(`readiness retries a transient ${code} probe within the startup budget`, async () => {
    let probes = 0;
    await waitForWorkerReady({ ...options, readStatus: async () => {
      if (++probes < 3) throw Object.assign(new Error('probe interrupted'), { code });
      return ready;
    } });
    assert.equal(probes, 3);
  });
}

test('readiness exhausts its deadline and reports the last probe failure', async () => {
  let probes = 0;
  await assert.rejects(waitForWorkerReady({ ...options, timeoutMs: 15, readStatus: async () => {
    probes++;
    throw new WorkerError('worker_status_timeout', 'last socket probe timed out');
  } }), error => error.code === 'worker_update_startup_timeout'
    && error.message.includes('last socket probe timed out'));
  assert(probes > 1);
});

test('readiness immediately rejects invalid status and explicit blocked failures', async () => {
  const invalid = new WorkerError('worker_status_invalid');
  await assert.rejects(waitForWorkerReady({ ...options, readStatus: async () => { throw invalid; } }), invalid);
  await assert.rejects(waitForWorkerReady({ ...options,
    readStatus: async () => ({ ...ready, phase: 'blocked', failure: 'authentication rejected' }),
  }), /authentication rejected/);
});
