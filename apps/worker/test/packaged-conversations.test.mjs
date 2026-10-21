import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { persistentFixtureRoot } from './fixtureStorage.mjs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { readProductEnvironment } from '../../../packages/contracts/src/productEnvironment.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

test('packaged conversations use the existing authenticated carrier and do not allocate on a fresh read', async t => {
  let artifact = readProductEnvironment(process.env, 'WORKER_ARTIFACT_DIRECTORY');
  if (!artifact) {
    const directory = await mkdtemp(join(persistentFixtureRoot, 'worker-conversations-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    artifact = join(directory, 'release');
    execFileSync(process.execPath, ['scripts/build-worker-artifact.mjs',
      'apps/worker/artifacts/ubuntu-26.04-x64-target.json', artifact,
      'apps/worker/artifacts/node-22.23.3-linux-x64.json'],
    { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const { createWorkerExecutionDomains } = await import(pathToFileURL(join(artifact, 'src/worker.mjs')).href);
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1,
    keyRevision: 1, authorizationRevision: 1 };
  const hostRef = { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId };
  const binding = { owner: { kind: 'agent', conversationId: 'recorded-chat', agentId: 'recorded-agent',
    workspaceId: 'recorded-workspace', workflowId: 'recorded-workflow', workflowNodeId: 'recorded-node',
    configurationVersionId: randomUUID(), configurationHash: `sha256:${'a'.repeat(64)}` },
    profile: { instanceId: randomUUID(), instanceRevision: 'recorded-profile', target: { hostRef,
      applicationInstallationId: connection.workerInstallationId, harnessInstallationId: 'recorded-installation',
      installationFingerprint: 'recorded-fingerprint' } },
    harness: 'codex', workingDirectory: '/recorded/project', appMcpAccess: 'none' };
  let reads = 0;
  const domain = createWorkerExecutionDomains({ workflows: { connection }, conversations: {
    currentBinding: () => connection,
    authorize: async request => {
      if (request.binding.owner.conversationId !== binding.owner.conversationId) throw new Error('Conversation denied');
    },
    journal: { read: async () => { reads++; return undefined; } },
    allocate: async () => { throw new Error('A status read cannot allocate a native process'); },
  } });
  const carrier = domain.extensions[0];
  const context = { binding: connection, signal: AbortSignal.timeout(1000) };
  try {
    assert.equal(carrier.namespace, 'execution-v1');
    const frame = { method: 'conversation.status', binding };
    assert.deepEqual(await carrier.handle(frame, context), { payload: { receipt: undefined } });
    assert.equal(reads, 1);
    await assert.rejects(carrier.handle({ ...frame, binding: { ...binding,
      owner: { ...binding.owner, conversationId: 'another-chat' } } }, context), /Conversation denied/);
    await assert.rejects(carrier.handle(frame, { ...context,
      binding: { ...connection, authorizationRevision: 2 } }), /generation is unavailable/);
    await assert.rejects(carrier.handle(frame, { ...context, bytes: new Uint8Array([1]) }), /cannot contain binary/);
    assert.equal(reads, 1);
  } finally { await domain.close(); }
});
