import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { MainWorkerConversationBridge } from './workerBridge.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import type { WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'

function setup() {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const current = vi.fn(async () => {})
  const send = vi.fn(async (payload: unknown) => ({ payload: { received: payload } }))
  const request: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding: f.binding,
    session: f.session, prompt: 'Admitted task', correlationId: 'original-correlation', sessionMode: 'plan' }
  const submitted = vi.fn(async () => {})
  const applied = vi.fn(async () => {})
  const lease = bridge.capture({ request, current, channel: { binding: f.connection, request: send },
    callbacks: { submitted, settingsApplied: applied } })
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload,
    binding: f.binding, admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  return { ...f, bridge, current, send, request, submitted, applied, lease, invoke }
}

it('journals a terminal callback only after its native message was acknowledged on the same admission', async () => {
  const f = workerConversationFixture('operator', 'claude')
  const bridge = new MainWorkerConversationBridge()
  const current = vi.fn(async () => {})
  const terminal = vi.fn(async () => {})
  const correlationId = 'accepted-message'
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'native-input', clientCorrelationId: correlationId }
  const lease = bridge.capture({ request: { method: 'conversation.start-turn', binding: f.binding,
    session: f.session, prompt: 'Accepted input', correlationId }, current,
    channel: { binding: f.connection, request: async () => ({ payload: {} }) },
    callbacks: { submitted: async () => {}, terminalObserved: terminal } })
  const observation = { submission, result: { outcome: 'succeeded' as const },
    history: { events: [], pendingInteractions: [], correlationId, nativeSubmission: submission } }
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload, binding: f.binding,
    admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  try {
    await expect(invoke({ method: 'conversation.terminal-observed', observation }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CALLBACK_DENIED' })
    expect(terminal).not.toHaveBeenCalled()
    await invoke({ method: 'conversation.submitted', correlationId, identity: { nativeSubmission: submission } })
    await expect(invoke({ method: 'conversation.terminal-observed', observation: { ...observation,
      submission: { ...submission, nativeMessageId: 'foreign-input' } } }))
      .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_CALLBACK_DENIED' })
    await invoke({ method: 'conversation.terminal-observed', observation })
    expect(terminal).toHaveBeenCalledExactlyOnceWith(observation)
    current.mockRejectedValueOnce(new Error('Sender revoked'))
    await expect(invoke({ method: 'conversation.terminal-observed', observation })).rejects.toThrow('Sender revoked')
    expect(terminal).toHaveBeenCalledTimes(1)
  } finally { await lease.close(); await bridge.close() }
})

it('authorizes only the Main-issued request and rechecks its live grants', async () => {
  const f = setup()
  await f.lease.request()
  const frame = f.send.mock.calls[0]![0]
  expect(await f.invoke({ method: 'conversation.authorize', request: frame })).toEqual({ authorized: true })
  expect(f.current.mock.calls.length).toBeGreaterThanOrEqual(3)
  await expect(f.invoke({ method: 'conversation.authorize', request: { ...f.request,
    admissionId: f.lease.admissionId, prompt: 'Replacement task' } })).rejects.toMatchObject({ status: 403 })
  f.current.mockRejectedValueOnce(new Error('Principal revoked'))
  await expect(f.invoke({ method: 'conversation.authorize', request: frame })).rejects.toThrow('Principal revoked')
  await f.lease.close()
})

it('allows a scoped access change only through its issued attachment or credential-delivery admission', async () => {
  const f = workerConversationFixture()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const current = vi.fn(async () => {})
  const bridge = new MainWorkerConversationBridge()
  const channel = { binding: f.connection, request: async () => ({ payload: {} }) }
  const open: WorkerConversationRpcRequest = { method: 'conversation.open', binding: next,
    previousBinding: f.binding, mode: 'attach', source: f.session,
    operationId: 'admitted-message', configuration: f.configuration }
  const lease = bridge.capture({ request: open, current, channel })
  const authorize = () => bridge.authorizeAppAccessChange(lease.admissionId, f.binding, next,
    f.connection, AbortSignal.timeout(1000))
  await expect(authorize()).resolves.toBeUndefined()
  current.mockRejectedValueOnce(new Error('Sender revoked'))
  await expect(authorize()).rejects.toThrow('Sender revoked')
  await lease.close()
  await expect(authorize()).rejects.toMatchObject({ status: 403 })
  const inspection = bridge.capture({ request: { method: 'conversation.capabilities', binding: next,
    configuration: f.configuration }, current, channel })
  await expect(bridge.authorizeAppAccessChange(inspection.admissionId, f.binding, next,
    f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await inspection.close()
})

it('uses the current callback signal after an earlier request signal has ended', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const before = new AbortController()
  const current = vi.fn(async (signal?: AbortSignal) => { signal?.throwIfAborted() })
  const send = vi.fn(async (payload: unknown) => ({ payload }))
  const lease = bridge.capture({ request: { method: 'conversation.status', binding: f.binding }, current,
    channel: { binding: f.connection, request: send } })
  await lease.request(before.signal)
  before.abort(new Error('Earlier HTTP request ended'))
  const callback = { method: 'conversation.authorize', binding: f.binding, admissionId: lease.admissionId,
    request: send.mock.calls[0]![0] }
  await expect(bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).resolves.toEqual({ authorized: true })
  const stopped = new AbortController()
  stopped.abort(new Error('Current callback ended'))
  await expect(bridge.handle(callback, f.connection, stopped.signal)).rejects.toThrow('Current callback ended')
  await lease.close()
})

it('requires a persisted Claude message acknowledgement before authorizing native callbacks', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const binding = { ...f.binding, harness: 'claude' as const }
  const session = { ...f.session, harness: 'claude' as const, providerVersion: '2.1.284' }
  const request: WorkerConversationRpcRequest = { method: 'conversation.start-turn', binding, session,
    prompt: 'Recorded input', correlationId: 'message-correlation' }
  const current = vi.fn(async () => {})
  const authority = vi.fn(async () => ({ authorized: true }))
  const lease = bridge.capture({ request, current, channel: { binding: f.connection, request: async () => ({ payload: {} }) },
    callbacks: { claudeAuthority: authority, submitted: async () => {} } })
  const invoke = (payload: Record<string, unknown>) => bridge.handle({ ...payload,
    binding, admissionId: lease.admissionId }, f.connection, AbortSignal.timeout(1000))
  const identity = { ownerPrincipalId: 'sender', attemptId: 'request', nativeSessionId: session.nativeSessionId,
    nativeMessageId: 'native-message', clientCorrelationId: 'message-correlation', generation: 'sdk-generation', toolUseId: 'tool' }
  const validate = { method: 'conversation.claude-authority', request: { phase: 'validate', identity } }
  await expect(invoke(validate)).rejects.toMatchObject({ status: 403 })
  expect(authority).not.toHaveBeenCalled()
  await invoke({ method: 'conversation.submitted', correlationId: 'message-correlation', identity: {
    nativeSubmission: { kind: 'message', nativeSessionId: session.nativeSessionId,
      nativeMessageId: 'native-message', clientCorrelationId: 'message-correlation' } } })
  await expect(invoke(validate)).resolves.toEqual({ authorized: true })
  await expect(invoke({ ...validate, request: { phase: 'validate', identity: { ...identity, nativeMessageId: 'another-message' } } }))
    .rejects.toMatchObject({ status: 403 })
  await expect(invoke({ ...validate, request: { phase: 'validate', identity: { ...identity, generation: 'another-query' } } }))
    .rejects.toMatchObject({ status: 403 })
  current.mockRejectedValueOnce(new Error('Original sender revoked'))
  await expect(invoke(validate)).rejects.toThrow('Original sender revoked')
  await lease.close()
  await expect(invoke(validate)).rejects.toMatchObject({ status: 403 })
})

it('never lets a read-only conversation lease supply new Claude message authority', async () => {
  const f = workerConversationFixture()
  const bridge = new MainWorkerConversationBridge()
  const binding = { ...f.binding, harness: 'claude' as const }
  const request: WorkerConversationRpcRequest = { method: 'conversation.status', binding }
  const authority = vi.fn(async () => ({ ownerPrincipalId: 'sender', attemptId: 'request' }))
  const lease = bridge.capture({ request, current: async () => {},
    channel: { binding: f.connection, request: async () => ({ payload: {} }) }, callbacks: { claudeAuthority: authority } })
  await expect(bridge.handle({ method: 'conversation.claude-authority', binding, admissionId: lease.admissionId,
    request: { phase: 'admission' } }, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  expect(authority).not.toHaveBeenCalled()
  await lease.close()
})

it('keeps recovered Claude callbacks on the submitted message and current sender grants', async () => {
  const f = workerConversationFixture('agent', 'claude')
  const bridge = new MainWorkerConversationBridge()
  const correlationId = 'existing-message'
  const submission = { kind: 'message' as const, nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'submitted-native-message', clientCorrelationId: correlationId }
  const request: WorkerConversationRpcRequest = { method: 'conversation.reconcile', binding: f.binding,
    session: f.session, correlationId }
  const current = vi.fn(async () => {})
  const authority = vi.fn(async () => ({ authorized: true }))
  const channel = { binding: f.connection, request: async () => ({ payload: {} }) }
  const lease = bridge.capture({ request, current, channel, recoveredSubmission: submission,
    callbacks: { claudeAuthority: authority } })
  const identity = { ownerPrincipalId: 'original-sender', attemptId: 'original-request',
    nativeSessionId: f.session.nativeSessionId, nativeMessageId: submission.nativeMessageId,
    clientCorrelationId: correlationId, generation: 'original-query', toolUseId: 'original-tool' }
  const invoke = (value: typeof identity) => bridge.handle({ method: 'conversation.claude-authority', binding: f.binding,
    admissionId: lease.admissionId, request: { phase: 'validate', identity: value } }, f.connection, AbortSignal.timeout(1000))
  expect(await invoke(identity)).toEqual({ authorized: true })
  await expect(invoke({ ...identity, nativeMessageId: 'different-message' })).rejects.toMatchObject({ status: 403 })
  await expect(invoke({ ...identity, generation: 'different-query' })).rejects.toMatchObject({ status: 403 })
  current.mockRejectedValueOnce(new Error('Sender revoked'))
  await expect(invoke(identity)).rejects.toThrow('Sender revoked')
  expect(authority).toHaveBeenCalledOnce()
  await lease.close()
  await expect(invoke(identity)).rejects.toMatchObject({ status: 403 })
  expect(() => bridge.capture({ request, current, channel,
    recoveredSubmission: { ...submission, nativeSessionId: 'another-session' } })).toThrow()
  const reader = bridge.capture({ request, current, channel, callbacks: { claudeAuthority: authority } })
  await expect(bridge.handle({ method: 'conversation.claude-authority', binding: f.binding,
    admissionId: reader.admissionId, request: { phase: 'admission' } }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await reader.close()
})

it('rejects unissued admissions, foreign conversations and other authenticated generations', async () => {
  const f = setup()
  const callback = { method: 'conversation.submitted', admissionId: f.lease.admissionId,
    binding: f.binding, correlationId: 'original-correlation', identity: { nativeTurnId: 'observed-turn' } }
  await expect(f.bridge.handle({ ...callback, admissionId: randomUUID() }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle({ ...callback, binding: { ...f.binding,
    owner: { ...f.binding.owner, conversationId: randomUUID() } } }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle(callback, { ...f.connection, connectionEpoch: randomUUID() }, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  expect(f.submitted).not.toHaveBeenCalled()
  await f.lease.close()
})

it('preserves provider identity and refuses a different message, turn or correlation', async () => {
  const f = setup()
  const submission = { method: 'conversation.submitted', correlationId: 'original-correlation',
    identity: { nativeTurnId: 'observed-turn' } }
  expect(await f.invoke(submission)).toEqual({ acknowledged: true })
  expect(f.submitted).toHaveBeenCalledWith('original-correlation', { nativeTurnId: 'observed-turn' })
  await expect(f.invoke({ ...submission, correlationId: 'another-correlation' })).rejects.toMatchObject({ status: 403 })
  await expect(f.invoke({ ...submission, identity: { nativeTurnId: 'different-turn' } })).rejects.toMatchObject({ status: 403 })
  await expect(f.invoke({ ...submission, identity: { nativeSubmission: { kind: 'message',
    clientCorrelationId: 'original-correlation', nativeSessionId: 'foreign-session', nativeMessageId: 'observed-message' } } }))
    .rejects.toMatchObject({ status: 403 })
  expect(f.submitted).toHaveBeenCalledOnce()
  await f.lease.close()
})

it('does not acknowledge failed persistence and rejects callbacks after Main detaches', async () => {
  const f = setup()
  const callback = { method: 'conversation.submitted', correlationId: 'original-correlation', identity: { nativeTurnId: 'observed-turn' } }
  f.submitted.mockRejectedValueOnce(new Error('Persistence failed'))
  await expect(f.invoke(callback)).rejects.toThrow('Persistence failed')
  expect(await f.invoke(callback)).toEqual({ acknowledged: true })
  await f.lease.close()
  await expect(f.invoke(callback)).rejects.toMatchObject({ status: 403 })
  expect(f.submitted).toHaveBeenCalledTimes(2)
})

it('keeps read admissions unable to claim execution or applied settings', async () => {
  const f = setup()
  const observed = vi.fn(async () => {})
  const applied = vi.fn(async () => {})
  const reader = f.bridge.capture({ request: { method: 'conversation.status', binding: f.binding }, current: f.current,
    channel: { binding: f.connection, request: f.send }, callbacks: { sessionObserved: observed, settingsApplied: applied } })
  await expect(f.bridge.handle({ method: 'conversation.session-observed', binding: f.binding,
    admissionId: reader.admissionId, session: f.session }, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await expect(f.bridge.handle({ method: 'conversation.settings-applied', binding: f.binding,
    admissionId: reader.admissionId, correlationId: 'original-correlation' }, f.connection, AbortSignal.timeout(1000)))
    .rejects.toMatchObject({ status: 403 })
  expect(observed).not.toHaveBeenCalled()
  expect(applied).not.toHaveBeenCalled()
  await reader.close()
  await f.lease.close()
})

it('forwards the native applied-settings acknowledgement only for the admitted turn', async () => {
  const f = setup()
  expect(await f.invoke({ method: 'conversation.settings-applied', correlationId: 'original-correlation' }))
    .toEqual({ acknowledged: true })
  expect(f.applied).toHaveBeenCalledOnce()
  await f.bridge.close()
  await expect(f.lease.request()).rejects.toMatchObject({ status: 403 })
})

it('keeps native profile reads on a live Main-issued request and rechecks the caller', async () => {
  const f = setup()
  const profile = vi.fn(async () => { throw new Error('Profile unavailable') })
  const reader = f.bridge.capture({ request: { method: 'conversation.capabilities', binding: f.binding,
    configuration: f.configuration }, current: f.current, channel: { binding: f.connection, request: f.send },
    callbacks: { profile } })
  const callback = { method: 'conversation.profile', binding: f.binding, admissionId: reader.admissionId }
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toThrow('Profile unavailable')
  expect(profile).toHaveBeenCalledOnce()
  f.current.mockRejectedValueOnce(new Error('Read grant revoked'))
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toThrow('Read grant revoked')
  expect(profile).toHaveBeenCalledOnce()
  await reader.close()
  await expect(f.bridge.handle(callback, f.connection, AbortSignal.timeout(1000))).rejects.toMatchObject({ status: 403 })
  await f.lease.close()
})
