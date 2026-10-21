import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'
import type { WorkerClaudeAuthorityRequest, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeTurnInput } from '../harnesses/port.js'
import type { ClaudeNativeSessionManager } from '../harnesses/claudeSdk/sessionManager.js'
import { createWorkerClaudeAuthority } from './workerClaudeAuthority.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { memoryClaudeCallbackJournal } from '../../../test/support/claudeCallbackJournal.js'

// Only provider I/O is recorded here; this does not qualify a native installation.
function fixture() {
  const f = workerConversationFixture('agent', 'claude')
  const agent = f.configuration
  if (!('agentId' in agent)) throw new Error('Agent fixture required')
  if (f.configuration.harness.harness !== 'claude') throw new Error('Claude fixture required')
  const configuration = { ...f.configuration.harness, tools: ['Read'] }
  const correlationId = 'original-message'
  const source: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding: f.binding,
    session: f.session, prompt: 'Read only', correlationId, admissionId: randomUUID() }
  const submission: NativeMessageSubmission = { kind: 'message', nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'native-message', clientCorrelationId: correlationId }
  const request = vi.fn(async (source: WorkerConversationRpcRequest, authority: WorkerClaudeAuthorityRequest): Promise<unknown> => {
    if (!source.admissionId) throw new Error('Missing Main admission')
    return authority.phase === 'admission' ? { ownerPrincipalId: 'original-sender', attemptId: 'original-request' }
      : { authorized: true }
  })
  const controls = createWorkerClaudeAuthority({ configuration, version: f.session.providerVersion,
    source: () => source, signal: AbortSignal.timeout(5000), request, callbackJournal: memoryClaudeCallbackJournal() })
  const nativeStart = vi.fn(async function* (_session: unknown, message: NativeTurnInput) {
    await message.onMessageSubmitted?.(submission)
    yield { sequence: 1, type: 'session.pending', occurredAt: new Date().toISOString(), payload: {} }
  })
  const manager = { startTurn: nativeStart, startInitialTurn: nativeStart,
    attachSession: async (session: typeof f.session) => session,
    history: async () => ({ events: [], pendingInteractions: [] }),
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    notifyPendingChanged: () => {} } as unknown as ClaudeNativeSessionManager
  controls.bind(manager)
  const recovery: Extract<WorkerConversationRpcRequest, { method: 'conversation.history' | 'conversation.reconcile' }> = {
    method: 'conversation.reconcile', binding: f.binding, session: f.session,
    correlationId, admissionId: randomUUID(),
  }
  const identity = { ownerPrincipalId: 'original-sender', attemptId: 'original-request',
    nativeSessionId: f.session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
    clientCorrelationId: correlationId, toolUseId: 'tool-use', generation: 'original-query' }
  const stream = (async function* () {
    await manager.attachSession(f.session, { kind: 'agent-chat', configuration: agent,
      correlationId,
      conversationId: f.binding.owner.conversationId, workflowId: 'workflow', workflowNodeId: 'node',
      workingDirectory: f.binding.workingDirectory })
    yield* manager.startTurn(f.session, { prompt: source.prompt, clientCorrelationId: correlationId,
      onMessageSubmitted: async () => {} })
  })()[Symbol.asyncIterator]()
  return { ...f, controls, manager, stream, request, nativeStart, submission, source, recovery, identity }
}

it('reauthorizes the original callback on a replacement observer without sending native input again', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    await f.controls.recover(f.recovery, f.submission, AbortSignal.timeout(1000))
    expect(await f.controls.bridge.beforeToolUse(f.identity, 'Read', { file_path: '/approved/read-only' })).toEqual({})
    expect(f.request.mock.calls.at(-1)?.[0]).toEqual(f.recovery)
    expect(f.nativeStart).toHaveBeenCalledOnce()
  } finally { await f.stream.return?.(); await f.controls.bridge.close() }
})

it('rejects a different native message or sender while retaining the original callback owner', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    await expect(f.controls.recover(f.recovery, { ...f.submission, nativeMessageId: 'another-message' },
      AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
    f.request.mockResolvedValueOnce({ ownerPrincipalId: 'another-sender', attemptId: 'original-request' })
    await expect(f.controls.recover(f.recovery, f.submission, AbortSignal.timeout(1000)))
      .rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
    expect(await f.controls.bridge.beforeToolUse(f.identity, 'Read', {})).toEqual({})
    expect(f.request.mock.calls.at(-1)?.[0]).toEqual(f.source)
    expect(f.nativeStart).toHaveBeenCalledOnce()
  } finally { await f.stream.return?.(); await f.controls.bridge.close() }
})

it('does not replace callback admission when the current sender is revoked', async () => {
  const f = fixture()
  try {
    await f.stream.next()
    f.request.mockRejectedValueOnce(new Error('Original sender revoked'))
    await expect(f.controls.recover(f.recovery, f.submission, AbortSignal.timeout(1000)))
      .rejects.toThrow('Original sender revoked')
    expect(await f.controls.bridge.beforeToolUse(f.identity, 'Read', {})).toEqual({})
    expect(f.request.mock.calls.at(-1)?.[0]).toEqual(f.source)
  } finally { await f.stream.return?.(); await f.controls.bridge.close() }
})

it('offers no worker input without a Main native-message acknowledgement callback', async () => {
  const f = fixture()
  const stream = f.manager.startTurn(f.session, { prompt: 'Read only',
    clientCorrelationId: f.submission.clientCorrelationId })[Symbol.asyncIterator]()
  try {
    await expect(stream.next()).rejects.toMatchObject({ code: 'CLAUDE_NATIVE_MESSAGE_NOT_ADMITTED' })
    expect(f.nativeStart).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  } finally { await stream.return?.(); await f.controls.bridge.close() }
})

it('forwards file calls only for the acknowledged root message and original sender', async () => {
  const f = fixture()
  const signal = AbortSignal.timeout(1000)
  try {
    await expect(f.controls.file(f.identity, 'files.read', { fileId: 'file', revisionId: 'revision' }, signal))
      .rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
    await f.stream.next()
    f.request.mockResolvedValueOnce({ status: 'ready', contentBase64: Buffer.from('attached').toString('base64') })
    expect(await f.controls.file(f.identity, 'files.read', { fileId: 'file', revisionId: 'revision' }, signal))
      .toEqual({ status: 'ready', contentBase64: Buffer.from('attached').toString('base64') })
    expect(f.request.mock.calls.at(-1)).toEqual([f.source, { phase: 'file', identity: f.identity,
      operation: 'files.read', args: { fileId: 'file', revisionId: 'revision' } }, signal])
    const count = f.request.mock.calls.length
    for (const identity of [{ ...f.identity, nativeMessageId: 'unacknowledged' },
      { ...f.identity, ownerPrincipalId: 'other-sender' }, { ...f.identity, attemptId: 'other-request' }]) {
      await expect(f.controls.file(identity, 'files.read', {}, signal))
        .rejects.toMatchObject({ code: 'CLAUDE_FILE_NATIVE_CONTEXT_REQUIRED' })
    }
    expect(f.request).toHaveBeenCalledTimes(count)
  } finally { await f.stream.return?.(); await f.controls.bridge.close() }
  await expect(f.controls.file(f.identity, 'files.read', {}, signal))
    .rejects.toMatchObject({ code: 'CLAUDE_CALLBACK_SCOPE_DENIED' })
})

it('reports a Main admission failure before initial input as definite non-delivery', async () => {
  const f = fixture()
  if (!('agentId' in f.configuration)) throw new Error('Agent configuration required')
  f.request.mockRejectedValueOnce(new Error('Main rejected this admission'))
  const observed = vi.fn(async () => {})
  const stream = f.manager.startInitialTurn({ kind: 'agent-chat', configuration: f.configuration,
    correlationId: f.submission.clientCorrelationId, conversationId: f.binding.owner.conversationId,
    workflowId: 'workflow', workflowNodeId: 'node', workingDirectory: f.binding.workingDirectory,
    instructionsDelivered: false }, { prompt: 'Not offered', clientCorrelationId: f.submission.clientCorrelationId,
    onMessageSubmitted: async () => {}, onSessionObserved: observed })[Symbol.asyncIterator]()
  try {
    await expect(stream.next()).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect(observed).not.toHaveBeenCalled()
    expect(f.nativeStart).not.toHaveBeenCalled()
  } finally { await stream.return?.(); await f.controls.bridge.close() }
})

it('refuses a replacement attached to a foreign session before offering input', async () => {
  const f = fixture()
  if (!('agentId' in f.configuration)) throw new Error('Agent configuration required')
  await f.manager.attachSession(f.session, { kind: 'agent-chat', configuration: f.configuration,
    correlationId: f.submission.clientCorrelationId, conversationId: f.binding.owner.conversationId,
    workflowId: 'workflow', workflowNodeId: 'node', workingDirectory: f.binding.workingDirectory,
    instructionsDelivered: false })
  f.manager.attachSession = async () => ({ ...f.session, nativeSessionId: 'foreign-session' })
  const stream = f.manager.startTurn(f.session, { prompt: 'Not offered',
    clientCorrelationId: f.submission.clientCorrelationId, onMessageSubmitted: async () => {} })[Symbol.asyncIterator]()
  try {
    await expect(stream.next()).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
    expect(f.nativeStart).not.toHaveBeenCalled()
  } finally { await stream.return?.(); await f.controls.bridge.close() }
})
