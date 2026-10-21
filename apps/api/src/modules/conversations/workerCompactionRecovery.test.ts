import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { readClaudeCompactionHistory } from '../harnesses/claudeSdk/compactionHistory.js'
import { saveClaudeCompactionResult } from '../harnesses/claudeSdk/compactionResults.js'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationCallbacks } from './workerCallbacks.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const recoveryCases = (['completed', 'failed'] as const).flatMap(status =>
  (['same', 'replacement'] as const).flatMap(boot =>
    (['dispose', 'restart'] as const).map(cleanup => ({ status, boot, cleanup }))))

it.each(recoveryCases)(
  'recovers Worker Claude $status compaction on a $boot boot with $cleanup cleanup without opening a writer',
  async ({ status, boot, cleanup }) => {
  const root = await mkdtemp(join(tmpdir(), 'worker-compaction-'))
  const f = workerConversationFixture('operator', 'claude')
  const connection = boot === 'same' ? f.connection : { ...f.connection, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: f.connection.connectionGeneration + 1 }
  if (!('operatorId' in f.configuration) || f.configuration.harness.harness !== 'claude') throw new Error('Claude Operator fixture required')
  const configuration = { ...f.configuration, harness: { ...f.configuration.harness, configDirectory: root } }
  const binding = WorkerConversationBindingSchema.parse({ ...f.binding,
    owner: { ...f.binding.owner, configurationHash: commandInputHash(configuration) } })
  const session = { nativeSessionId: f.session.nativeSessionId, profilePath: root,
    cwd: binding.workingDirectory, configRevision: configuration.id, deviceId: f.connection.deviceId }
  const directory = join(root, 'projects', '-approved-project')
  const transcript = join(directory, `${session.nativeSessionId}.jsonl`)
  const frame = (uuid: string, trigger: string) => JSON.stringify({ type: 'system', subtype: 'compact_boundary',
    uuid, sessionId: session.nativeSessionId, cwd: session.cwd,
    compactMetadata: { trigger, preTokens: 12000 }, timestamp: '2026-10-05T00:00:00.000Z' }) + '\n'
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), { initializeNewInstallation: true })
  const bridge = new MainWorkerConversationBridge()
  let allocations = 0
  let allowed = true
  const callbacks = workerConversationCallbacks({ currentBinding: () => connection,
    capture: () => ({ binding: connection, request: async payload => ({
      payload: await bridge.handle(payload, connection, AbortSignal.timeout(1000)),
    }) }) })
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: () => connection,
    journal: journal.conversations, allocate: async () => { allocations++; throw new Error('Cold read opened a writer') } })
  const manager = new WorkerConversationManager({ binding, configuration, bridge,
    channel: { binding: connection, request: async payload => ({ payload: await host.handle(payload, connection) }) },
    current: async () => { if (!allowed) throw new Error('Read grant revoked') } })
  try {
    await mkdir(directory, { recursive: true })
    await appendFile(transcript, frame('old-manual', 'manual'))
    const before = await readClaudeCompactionHistory(session)
    await journal.conversations.receive(binding, f.connection)
    await journal.conversations.reserveCreation(binding, 'first-message', commandInputHash('first-message'))
    await journal.conversations.bindSession(binding, f.session, f.nativeOwner)
    const reserved = await journal.conversations.reserveCompact(binding, 'compact-request', commandInputHash('compact-request'))
    const claudeSession = { profilePath: root, cwd: session.cwd,
      configRevision: session.configRevision, deviceId: session.deviceId }
    const nativeRequestId = randomUUID()
    const state = { ...reserved.state, status: 'uncertain' as const, nativeRequestId,
      claudeSession, claudeCursor: before.cursor }
    await journal.conversations.compactProgress(binding, state)
    const boundaryId = randomUUID()
    await appendFile(transcript, frame('automatic', 'auto') + frame(boundaryId, 'manual'))
    const start = { kind: 'operator' as const, configuration, correlationId: 'recovery-read',
      workingDirectory: binding.workingDirectory }
    const pending = await manager.readCompaction(f.session, start, state)
    expect(pending).toMatchObject({ status: 'uncertain', nativeOperationId: boundaryId, beforeTokens: 12000 })
    await expect(journal.conversations.reserveTurn(binding, 'early-message', commandInputHash('early-message')))
      .rejects.toThrow('pending')
    await saveClaudeCompactionResult(session, nativeRequestId, status)
    const recovered = await manager.readCompaction(f.session, start, pending)
    expect(recovered).toMatchObject({ requestId: state.requestId, nativeSessionId: session.nativeSessionId,
      status, nativeOperationId: boundaryId, beforeTokens: 12000 })
    expect((await journal.conversations.read(binding))?.compactions[0]?.state).toEqual(recovered)
    expect(allocations).toBe(0)
    expect(() => manager.startTurn(f.session, { prompt: 'This observer must not own a writer.',
      clientCorrelationId: randomUUID() })).toThrow('does not own')
    expect(allocations).toBe(0)
    expect((await journal.conversations.reserveTurn(binding, 'next-message', commandInputHash('next-message'))).dispatch)
      .toBe(true)
    allowed = false
    await expect(manager.readCompaction(f.session, start, state)).rejects.toThrow('Read grant revoked')
    expect(allocations).toBe(0)
    const beforeDetach = await journal.conversations.read(binding)
    if (cleanup === 'dispose') await expect(manager.dispose()).resolves.toBeUndefined()
    else await manager.closeForRestart(f.session)
    expect(await journal.conversations.read(binding)).toEqual(beforeDetach)
    expect(allocations).toBe(0)
  } finally {
    await manager.dispose()
    await bridge.close()
    await host.shutdown()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  }
})
