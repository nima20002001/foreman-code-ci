import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { RemoteExecutionHost } from '../src/modules/runs/remote/executionHost.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { RemoteNativeSessionManager } from '../src/modules/runs/remote/nativeManagerProxy.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { input } from './fixtures/codex-test-helpers.js'
import { readUntil } from './helpers/observableCondition.js'

async function workerFixture() {
  const scratch = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'native-history-'))
  const journalPath = join(root, 'journal')
  const journal = await RemoteOperationJournal.open(journalPath, { initializeNewInstallation: true })
  const replay = new ActivityProductionReplay()
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded transport')
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
    undefined, 'none', undefined, infrastructure.codex)
  const start = input('/project')
  delete start.environment
  const request = { ...start.request, runtimeDirectory: '/runtime/execution' }
  const configuration = request.configuration
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  const digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId: connection.mainId,
    mainInstallationId: 'main-installation', runId: request.runId, nodeId: request.workflowNodeId,
    hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
    registration: { workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: request.executionId, occurrenceId: null,
    occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
    inputDigest: `sha256:${createHash('sha256').update('{}').digest('hex')}`, owner: { grantId: 'owner', epoch: '1' } })
  let allowed = true
  const host = new RemoteExecutionHost({ journal, connection, incarnationId: randomUUID(),
    managers: new ExecutionScopedNativeSessionManagerResolver(() => manager),
    authorize: async () => { if (!allowed) throw new Error('Worker access denied') },
    preflight: async () => {},
    attestRuntimeLeaf: async () => ({ executionId: intent.executionId, attemptId: intent.attemptId,
      operationId: intent.operationId, bindingHash: intent.bindingHash,
      canonicalRuntimeDirectory: request.runtimeDirectory, directoryIdentityHash: digest,
      materializationId: 'materialization', materializationDigest: digest }),
    nativeEvidence: async (_intent, session) => ({ sessionId: session.nativeSessionId, processIdentityDigest: digest }),
    settle: async (_intent, history) => history.terminalTurn ? { kind: 'completed',
      result: history.terminalTurn.result, closureEvidenceDigest: digest } : null,
  })
  const correlationId = `execution:${intent.executionId}`
  const historyCursors: Array<number | undefined> = []
  const proxy = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration,
    transport: { request: async (_method, raw) => {
      const frame = RemoteExecutionRpcRequestSchema.parse(raw)
      if (frame.method === 'history') historyCursors.push(frame.afterSequence)
      return host.handle(frame)
    } }, observeReceipt: async () => {}, controlFor: async () => { throw new Error('No control requested') } })
  return { host, journal, journalPath, root, replay, manager, proxy, historyCursors, correlationId,
    start: { request, correlationId }, intent, deny: () => { allowed = false },
    close: async () => { await host.shutdown(); await journal.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('native event retention recovery', () => {
  it('reads chronological Worker history beyond the recent observation window', async () => {
    const f = await workerFixture()
    try {
      const session = await f.proxy.createSession(f.start)
      const stream = f.proxy.startTurn(session, { prompt: 'busy turn', clientCorrelationId: f.correlationId })
      const first = await stream.next()
      expect(first.done).toBe(false)
      const turn = f.replay.starts[0]!
      for (let index = 0; index < 600; index++) f.replay.append(session.nativeSessionId, turn.nativeTurnId, 'x'.repeat(1024))
      const recent = await f.manager.history(session)
      expect(recent.firstRetainedSequence).toBeGreaterThan(first.value!.sequence + 1)
      const delivered = [first.value!]
      while (delivered.filter(event => event.payload.nativeMethod === 'item/agentMessage/delta').length < 600) {
        const next = await stream.next()
        expect(next.done).toBe(false)
        delivered.push(next.value!)
      }
      f.replay.complete(session.nativeSessionId, turn.nativeTurnId, 'original result')
      for await (const event of stream) delivered.push(event)
      expect(delivered.filter(event => event.payload.nativeMethod === 'item/agentMessage/delta')).toHaveLength(600)
      expect((await f.proxy.reconcile(session, f.correlationId)).terminalTurn?.result.output).toEqual({ text: 'original result' })
      expect(f.replay.starts).toHaveLength(1)
      f.deny()
      await expect(f.proxy.history(session)).rejects.toThrow('Worker access denied')
    } finally { await f.close() }
  }, 60_000)

  it('completes after Worker events were trimmed before the first read and keeps the saved result', async () => {
    const f = await workerFixture()
    try {
      const session = await f.proxy.createSession(f.start)
      await f.host.startTurn(f.intent.operationId, 'busy turn', f.correlationId)
      // Completion occurs before Main observes the turn, after the Worker has drained its live stream.
      await readUntil(() => f.manager.history(session),
        history => history.events.some(event => event.type === 'turn.started'),
        { timeoutMs: 5_000, description: 'the Worker turn acknowledgement' })
      const turn = f.replay.starts[0]!
      for (let index = 0; index < 1500; index++) f.replay.append(session.nativeSessionId, turn.nativeTurnId, `event-${index}`)
      f.replay.complete(session.nativeSessionId, turn.nativeTurnId, 'saved Worker result')
      await f.host.drain()
      const skipped: DeviceHistoryGap[] = []
      const turnInput = { prompt: 'busy turn', clientCorrelationId: f.correlationId,
        onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
      for await (const event of f.proxy.startTurn(session, turnInput)) expect(event.sequence).toBeGreaterThanOrEqual(0)
      expect(skipped.length).toBeGreaterThan(0)
      const observed = await f.proxy.reconcile(session, f.correlationId)
      expect(observed.terminalTurn?.providerId).toBe(turn.nativeTurnId)
      expect(observed.terminalTurn?.result).toEqual({ outcome: 'succeeded', output: { text: 'saved Worker result' } })
      expect(f.replay.starts).toHaveLength(1)
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(f.journalPath)
      try {
        const status = await reopened.status(f.intent.operationId)
        expect(status).toMatchObject({ status: 'known', receipt: { phase: 'confirmed_terminal',
          terminal: { kind: 'completed', result: observed.terminalTurn!.result } } })
      } finally { await reopened.close() }
    } finally { await f.close() }
  }, 60_000)

  it('keeps a local Codex turn alive when unread events exceed the memory cap', async () => {
    const replay = new ActivityProductionReplay()
    const infrastructure = replay.infrastructure()
    if (infrastructure.mode !== 'replay') throw new Error('Expected recorded transport')
    const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined,
      undefined, 'none', undefined, infrastructure.codex)
    try {
      const start = input('/project')
      delete start.environment
      const session = await manager.createSession(start)
      const skipped: DeviceHistoryGap[] = []
      const turnInput = { prompt: 'busy turn', clientCorrelationId: 'busy-turn',
        onEventsSkipped: async (gap: DeviceHistoryGap) => { skipped.push(gap) } }
      const stream = manager.startTurn(session, turnInput)[Symbol.asyncIterator]()
      expect((await stream.next()).done).toBe(false)
      const turn = replay.starts[0]!
      for (let index = 0; index < 66; index++) replay.channels.get(session.nativeSessionId)!.notify(
        'item/reasoning/textDelta', { threadId: session.nativeSessionId, turnId: turn.nativeTurnId,
          itemId: 'reasoning', delta: 'x'.repeat(2 * 1024 * 1024) })
      replay.complete(session.nativeSessionId, turn.nativeTurnId, 'local result')
      while (!(await stream.next()).done) { /* Drain retained events. */ }
      expect(skipped.length).toBeGreaterThan(0)
      expect((await manager.reconcile(session, 'busy-turn')).terminalTurn?.result.output).toEqual({ text: 'local result' })
      expect(replay.starts).toHaveLength(1)
    } finally { await manager.dispose() }
  }, 60_000)
})
