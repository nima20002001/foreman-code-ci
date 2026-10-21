import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startWorker } from '../src/runtime.mjs';

test('worker connection retains the supplied observed boot identity through its lifecycle', async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'worker-boot-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const bootId = '11111111-1111-4111-8111-111111111111';
  let received, stops = 0;
  const worker = await startWorker({ stateDirectory, loadIdentity: async () => ({ actual: 'test identity' }),
    readBootId: async () => bootId, createConnection: async (input) => {
      received = input;
      return { start: async () => {}, stop: async () => { stops++; } };
    } });
  assert.equal(worker.bootId, bootId);
  assert.equal(received.bootId, bootId);
  await worker.stop(); await worker.stop();
  assert.equal(stops, 1);
});

test('missing observed boot identity rejects before connection creation and releases its lock', async (t) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'worker-boot-'));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  let creates = 0;
  const options = { stateDirectory, loadIdentity: async () => ({}), createConnection: async () => {
    creates++; return { start: async () => {}, stop: async () => {} };
  } };
  await assert.rejects(startWorker({ ...options, readBootId: async () => '' }), /boot_identity_unavailable/);
  assert.equal(creates, 0);
  const worker = await startWorker({ ...options, readBootId: async () => '11111111-1111-4111-8111-111111111111' });
  await worker.stop();
});
