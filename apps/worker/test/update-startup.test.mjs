import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readUpdateRecord, superviseWorkerUpdate } from '../src/updateSupervisor.mjs';
import { runCiInstallSmoke } from '../src/ciInstallSmoke.mjs';

// Readiness has its own budget when smoke runs after the new process is ready.
test('update supervision gives process startup sixty seconds before separate CI smoke', async t => {
  const fixtureRoot = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'worker-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'versions'));
  const record = { format: 1, attemptDeadlineAt: Date.now() + 45 * 60_000,
    status: { state: 'restarting', currentVersion: '1.0.0', targetVersion: '1.1.0',
    manifestSha256: 'a'.repeat(64) }, manifestSha256: 'b'.repeat(64), restart: {
    service: 'graphql-worker.service', root, stateDirectory: root,
    pointer: { kind: 'file', path: join(root, 'release') }, directory: join(root, 'incoming'),
    previousDirectory: join(root, 'previous'), previousVersion: '1.0.0',
    workerInstallationId: '11111111-1111-4111-8111-111111111111', requestId: 'update-request',
    ciSmoke: { repository: 'fixture/project', commit: 'c'.repeat(40) },
  } };
  const phases = [];
  await superviseWorkerUpdate(record, {
    prepareService: async () => {}, switchPointer: async () => {}, restart: async () => {},
    persist: async () => {},
    ready: async options => {
      if (options.version === '1.1.0') assert.equal(options.timeoutMs, 60_000);
      phases.push('ready');
    },
    smoke: async () => { phases.push('smoke'); },
  });
  assert.equal(record.status.state, 'current');
  assert.deepEqual(phases, ['ready', 'smoke']);
});

async function deadlineFixture(t) {
  const fixtureRoot = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'worker-deadline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { format: 1, attemptDeadlineAt: Date.now() + 100,
    status: { state: 'restarting', currentVersion: '1.0.0', targetVersion: '1.1.0',
      manifestSha256: 'a'.repeat(64) }, manifestSha256: 'b'.repeat(64), restart: {
      service: 'graphql-worker.service', root, stateDirectory: root,
      pointer: { kind: 'file', path: join(root, 'release') }, directory: join(root, 'incoming'),
      previousDirectory: join(root, 'previous'), previousVersion: '1.0.0',
      workerInstallationId: '11111111-1111-4111-8111-111111111111', requestId: 'update-request',
      ciSmoke: { repository: 'fixture/project', commit: 'c'.repeat(40) },
    } };
}

for (const phase of ['restart', 'ready', 'smoke']) {
  test(`update supervision enforces the remaining attempt deadline during ${phase}`, async t => {
    const record = await deadlineFixture(t);
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: record.attemptDeadlineAt - 100 });
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    let phaseSignal;
    let stalled = false;
    let canceled = false;
    const stall = async signal => {
      if (stalled) return;
      stalled = true;
      phaseSignal = signal;
      entered.resolve();
      await release.promise;
    };
    const supervision = superviseWorkerUpdate(record, {
      prepareService: async () => {}, switchPointer: async () => {},
      restart: async (_service, options = {}) => {
        if (phase === 'restart') await stall(options.signal);
      },
      ready: async options => {
        if (phase === 'ready') await stall(options.signal);
      },
      smoke: async (plan, options = {}) => {
        if (phase !== 'smoke') return;
        await runCiInstallSmoke(plan.ciSmoke, { signal: options.signal, runner: { handle: async request => {
          if (request.operation === 'status') return { ready: true };
          if (request.operation === 'start') return {};
          if (request.operation === 'cancel') { canceled = true; return {}; }
          await stall(options.signal);
          return { run: { state: 'passed', step: 'integration', exitCode: 0 }, testResults: {
            summary: { passed: 1, failed: 0 }, files: [{ file: 'apps/api/test/ci-smoke.integration.test.ts',
              tests: [{ status: 'passed' }] }] } };
        } } });
      },
    });
    await entered.promise;
    t.mock.timers.tick(99);
    assert.equal(phaseSignal?.aborted ?? false, false);
    t.mock.timers.tick(1);
    release.resolve();
    await supervision;
    const saved = await readUpdateRecord(record.restart.stateDirectory);
    assert.equal(saved.status.state, 'rolled-back');
    assert.match(saved.status.lastError, /worker_update_deadline_exceeded/);
    assert.equal(saved.attemptDeadlineAt, record.attemptDeadlineAt);
    assert.equal(phaseSignal?.aborted, true);
    assert.equal(canceled, phase === 'smoke');
  });
}
