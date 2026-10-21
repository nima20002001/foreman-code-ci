import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function runCli(t, command, setupState) {
  const parent = join(homedir(), '.cache', 'foreman-tmp');
  await mkdir(parent, { recursive: true });
  const state = await mkdtemp(join(parent, 'worker-cli-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  if (command === 'pair') await writeFile(join(state, 'pairing.json'), '{}', { mode: 0o600 });
  const script = `
    import { registerHooks } from 'node:module';
    import { mock } from 'node:test';
    mock.timers.enable({ apis: ['setTimeout'] });
    const started = Promise.withResolvers();
    globalThis.workerStarted = started.resolve;
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/workerFactory.mjs')) return { format: 'module', shortCircuit: true, source: \`
        export const prepareWorkerState = async () => ({ version: '1.0.0' });
        export const initializeInstalledNativeRuntime = async () => {};
        export const startConfiguredWorker = async () => {
          globalThis.workerStarted();
          console.log('started');
          return { managedSetup: { state: '${setupState}' }, updating: () => false,
            stop: async () => { console.log('stopped'); } };
        };
      \` };
      if (url.endsWith('/deviceIdentityNode.ts')) return { format: 'module', shortCircuit: true,
        source: 'export const loadOrCreateWorkerIdentity = async () => ({}); export const loadWorkerPairing = async () => ({});' };
      if (url.endsWith('/updateSupervisor.mjs')) return { format: 'module', shortCircuit: true,
        source: 'export const recoverPendingWorkerUpdate = async () => {};' };
      if (url.endsWith('/enrollment.mjs')) return { format: 'module', shortCircuit: true, source: \`
        export const pairingErrorMessage = error => error.code;
        export const enrollWorker = async () => ({ paired: true });
      \` };
      return next(url, context);
    } });
    process.argv = [process.execPath, 'cli', '${command}', '--state', ${JSON.stringify(state)}
      ${command === 'pair' ? ", '--enrollment-file', '/private/enrollment.json'" : ''}];
    await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
    ${command === 'run' ? 'await started.promise;' : ''}
    await new Promise(setImmediate);
    mock.timers.tick(30_000);
    await new Promise(setImmediate);
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 5000,
  });
}

test('a Host CI Worker without a Job runtime stays running across the setup retry interval', async t => {
  const result = await runCli(t, 'run', 'runtime-unavailable');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'started');
});

test('failed managed setup still stops for a service retry at the existing interval', async t => {
  const result = await runCli(t, 'run', 'failed');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['started', 'stopped']);
});

test('the pair CLI accepts fresh enrollment input when an earlier pairing is present', async t => {
  const result = await runCli(t, 'pair');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { paired: true });
});
