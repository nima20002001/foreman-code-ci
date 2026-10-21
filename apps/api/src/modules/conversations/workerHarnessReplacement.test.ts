import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { WorkerConversationBindingSchema, WorkerConversationReceiptSchema,
  type WorkerConversationReceipt, type WorkerConversationConfiguration } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHarnessSessionManager, NativeInitialTurnInput, NativeHistory } from '../harnesses/port.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { WorkerConversationManager } from './workerManager.js'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { workerConversationAccountOwner } from './workerAccountSession.js'

it('replaces Codex with Claude, retains prior receipts, and fences duplicate and foreign inputs', async () => {
  const f = workerConversationFixture('agent')
  const base = AgentConfigurationVersionSchema.parse(f.configuration)
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => {
      const draft = structuredClone(records)
      const result = apply(draft)
      records.splice(0, records.length, ...draft)
      return structuredClone(result)
    } }, 8)
  const closed: string[] = []
  const offers: string[] = []
  const allocations: string[] = []
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async (_binding, selected: WorkerConversationConfiguration) => {
      const configuration = AgentConfigurationVersionSchema.parse(selected)
      const session: NativeSessionReference = { harness: configuration.harness.harness,
        providerVersion: 'provider-fixture', nativeSessionId: randomUUID() }
      const histories = new Map<string, NativeHistory>()
      allocations.push(configuration.harness.harness)
      const manager = { harness: session.harness,
        createSession: async () => session,
        async *startInitialTurn(_start: unknown, input: NativeInitialTurnInput) {
          offers.push(input.prompt)
          await input.onSessionObserved(session)
          const submission = { kind: 'message' as const, nativeSessionId: session.nativeSessionId,
            nativeMessageId: randomUUID(), clientCorrelationId: input.clientCorrelationId }
          await input.onMessageSubmitted?.(submission)
          const result = { outcome: 'succeeded' as const }
          histories.set(input.clientCorrelationId, { events: [], pendingInteractions: [],
            correlationId: input.clientCorrelationId, nativeSubmission: submission,
            terminalTurn: { correlationId: input.clientCorrelationId, providerId: submission.nativeMessageId, result },
            terminalResult: result })
          yield* []
        },
        pending: async () => undefined,
        reconcile: async (_session: unknown, correlation: string) => histories.get(correlation)!,
        close: async () => { closed.push(session.nativeSessionId) },
      } as unknown as NativeHarnessSessionManager
      return { manager, start: async () => ({ kind: 'agent-chat' as const, configuration,
        conversationId: f.binding.owner.conversationId, workflowId: 'workflow', workflowNodeId: 'node',
        correlationId: 'fixture', workingDirectory: f.binding.workingDirectory }),
      nativeOwner: async () => ({ sessionId: session.nativeSessionId, processIdentityDigest: 'a'.repeat(64) }),
      close: () => manager.close(session) }
    } })
  try {
    const first = await host.handle({ method: 'conversation.open', binding: f.binding,
      configuration: base, operationId: 'original-create', mode: 'create' }, f.connection) as { receipt: WorkerConversationReceipt }
    const oldSession = first.receipt.session!
    await journal.reserveTurn(f.binding, 'old-message', commandInputHash('old-message'))
    await journal.submitted(f.binding, 'old-message', { nativeTurnId: 'old-turn' })
    await journal.finishTurn(f.binding, 'old-message', { outcome: 'succeeded' })
    const before = (await journal.read(f.binding))!
    const claude = workerConversationFixture('agent', 'claude')
    const profile = { ...claude.binding.profile, target: { ...claude.binding.profile.target,
      hostRef: f.binding.profile.target.hostRef,
      applicationInstallationId: f.binding.profile.target.applicationInstallationId } }
    const configuration = AgentConfigurationVersionSchema.parse({ ...base, id: randomUUID(), version: 2,
      harness: claude.configuration.harness, harnessProfileSelection: profile })
    const binding = WorkerConversationBindingSchema.parse({ ...f.binding, harness: 'claude', profile,
      owner: { ...f.binding.owner, configurationVersionId: configuration.id,
        configurationHash: commandInputHash(configuration) } })
    const request = { method: 'conversation.initial-turn', binding, configuration,
      previousBinding: f.binding, previousConfiguration: base, operationId: 'replace-harness',
      correlationId: 'replace-harness', prompt: 'Prior conversation: remember amber. Continue.' }
    await host.handle(request, f.connection)
    await host.drainForUpdate()
    const replaced = WorkerConversationReceiptSchema.parse((await host.handle({ method: 'conversation.status', binding },
      f.connection) as { receipt: unknown }).receipt)
    expect(replaced.binding).toEqual(binding)
    expect(replaced.session?.harness).toBe('claude')
    expect(replaced.session?.nativeSessionId).not.toBe(oldSession.nativeSessionId)
    expect(replaced).toMatchObject({ sessionHistory: [expect.objectContaining({ binding: f.binding,
      session: oldSession, turns: before.turns, closed: true })] })
    expect(closed).toEqual([oldSession.nativeSessionId])
    expect(offers).toEqual([request.prompt])
    await host.handle(request, f.connection)
    await host.drainForUpdate()
    expect(offers).toEqual([request.prompt])
    expect(allocations).toEqual(['codex', 'claude'])
    const bridge = new MainWorkerConversationBridge()
    const observed: NativeSessionReference[] = []
    const recovered = new WorkerConversationManager({ binding, configuration, previousBinding: f.binding,
      previousConfiguration: base, bridge, current: async () => {},
      observeSession: async session => { observed.push(session) },
      channel: { binding: f.connection, request: async frame => ({ payload: await host.handle(frame, f.connection) }) } })
    try {
      const session = await recovered.reconcileSessionCreation({ kind: 'agent-chat', configuration,
        conversationId: binding.owner.conversationId, workflowId: 'workflow', workflowNodeId: 'node',
        correlationId: request.operationId, workingDirectory: binding.workingDirectory })
      expect(session).toEqual(replaced.session)
      expect(observed).toEqual([replaced.session])
      expect(offers).toEqual([request.prompt])
      expect(allocations).toEqual(['codex', 'claude'])
    } finally { await recovered.dispose(); await bridge.close() }
    await expect(host.handle({ ...request, prompt: 'Changed retry' }, f.connection)).rejects.toThrow()
    await expect(host.handle({ method: 'conversation.start-turn', binding: f.binding, session: oldSession,
      correlationId: 'old-message', prompt: 'old-message' }, f.connection)).rejects.toThrow()
    const foreign = structuredClone(request)
    foreign.binding.profile.target.hostRef = { kind: 'device', mainId: randomUUID(), deviceId: randomUUID() }
    await expect(host.handle(foreign, f.connection)).rejects.toThrow()
    expect(offers).toHaveLength(1)
  } finally { await host.shutdown() }
})


it('keeps provider account pins separate across Agent native session generations', async () => {
  const f = workerConversationFixture('agent')
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => {
      const draft = structuredClone(records)
      const result = apply(draft)
      records.splice(0, records.length, ...draft)
      return structuredClone(result)
    } }, 8)
  await journal.receive(f.binding, f.connection)
  const original = await workerConversationAccountOwner(f.binding, journal,
    { method: 'conversation.status', binding: f.binding })
  await journal.closeRequested(f.binding)
  await journal.closeConfirmed(f.binding)
  const binding = WorkerConversationBindingSchema.parse({ ...f.binding, generation: randomUUID() })
  await journal.receive(binding, f.connection)
  const replacement = await workerConversationAccountOwner(binding, journal,
    { method: 'conversation.status', binding })
  expect(original).toBe(`conversation:${f.binding.owner.conversationId}`)
  expect(replacement).toBe(`${original}:session:${binding.generation}`)
  expect(replacement).not.toBe(original)
})
