import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkerArtifactReplySchema } from '../../../packages/contracts/src/workerUpdate.ts';
import { WORKER_CI_CAPACITY_WAIT_MS, WORKER_CI_SMOKE_TIMEOUT_MS } from './ciSmokeTiming.mjs';

export async function runCiInstallSmoke({ repository, commit }, { runner,
  timeoutMs = WORKER_CI_SMOKE_TIMEOUT_MS, capacityTimeoutMs = WORKER_CI_CAPACITY_WAIT_MS,
  pollMs = 1000, signal } = {}) {
  signal?.throwIfAborted();
  const runId = randomUUID();
  const controller = new AbortController();
  const deadline = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  // One preparation deadline covers the capacity wait and the run's dependency install, which fills the shared
  // store online when the commit pins new packages (a platform-native payload is over 100 MB).
  let preparation = 'capacity wait';
  const timer = setTimeout(() => controller.abort(new Error(`Worker CI smoke ${preparation} timed out.`)),
    capacityTimeoutMs);
  const smokeDeadline = () => setTimeout(() => controller.abort(new Error('Worker CI smoke timed out.')), timeoutMs);
  let smokeTimer;
  let smokeStarted = false;
  const expired = new Promise((_, reject) => {
    deadline.addEventListener('abort', () => reject(deadline.reason), { once: true });
  });
  const bounded = work => { deadline.throwIfAborted(); return Promise.race([work(), expired]); };
  try {
    const status = await bounded(() => runner.handle({ operation: 'status' }));
    if (!status.ready) throw new Error(`Worker CI smoke setup: ${status.reasons.join('; ')}`);
    while (true) {
      try {
        await bounded(() => runner.handle({ operation: 'start', runId, repository, commit, suite: 'integration',
          scope: 'affected', files: ['apps/api/test/ci-smoke.integration.test.ts'] }));
        break;
      } catch (error) {
        if (error.code !== 'CI_HOST_BUSY') throw error;
        await delay(pollMs, undefined, { signal: deadline });
      }
    }
    preparation = 'dependency install';
    smokeTimer = smokeDeadline();
    while (true) {
      const reply = await bounded(() => runner.handle({ operation: 'read', runId, afterOffset: 0,
        maxBytes: 8192, testResults: true }));
      if (!smokeStarted && reply.run.step === 'install') {
        clearTimeout(smokeTimer);
      } else if (!smokeStarted && ['contracts', 'prepare', 'integration'].includes(reply.run.step)) {
        smokeStarted = true;
        clearTimeout(timer);
        clearTimeout(smokeTimer);
        smokeTimer = smokeDeadline();
      }
      if (reply.run.state === 'passed' && reply.run.exitCode === 0) {
        const file = reply.testResults?.files.find(file => file.file === 'apps/api/test/ci-smoke.integration.test.ts');
        if (!file?.tests.some(test => test.status === 'passed') || reply.testResults.summary.failed !== 0) {
          throw new Error(`Worker CI smoke ${runId} passed without running the smoke test.`);
        }
        return;
      }
      if (['failed', 'lost', 'canceled'].includes(reply.run.state)) {
        throw new Error(`Worker CI smoke ${runId}: ${reply.run.message ?? reply.run.state}\n${reply.text}`);
      }
      await delay(pollMs, undefined, { signal: deadline });
    }
  } catch (error) {
    const failure = deadline.aborted ? deadline.reason : error;
    const cancellation = runner.handle({ operation: 'cancel', runId });
    await Promise.race([cancellation.catch(failure => {
      process.stderr.write(`Worker CI smoke cancellation failed: ${failure.message}\n`);
    }), delay(5000)]);
    throw failure;
  } finally {
    clearTimeout(timer);
    clearTimeout(smokeTimer);
  }
}

export async function readWorkerSmokeConfiguration(request, manifestSha256) {
  const response = await request({ operation: 'ci-smoke', manifestSha256 });
  const reply = WorkerArtifactReplySchema.parse(response.payload);
  if (reply.operation !== 'ci-smoke' || response.bytes !== undefined) {
    throw new Error('Worker CI smoke configuration reply is invalid.');
  }
  return reply.ciSmoke;
}

export async function runWorkerStartupSmoke({ manifestSha256, request, smoke }) {
  if (process.env.FOREMAN_INSTALL_SKIP_CI_SMOKE === '1') {
    process.stderr.write('Worker startup CI smoke explicitly skipped (FOREMAN_INSTALL_SKIP_CI_SMOKE=1).\n');
    return;
  }
  const configuration = await readWorkerSmokeConfiguration(request, manifestSha256);
  if (configuration) await smoke(configuration);
}

export function workerCiStartupStatus(status, smoke) {
  if (status.phase !== 'ready' || !smoke.pending) return status;
  return { ...status, phase: smoke.error ? 'blocked' : 'synchronizing', failure: smoke.error };
}
