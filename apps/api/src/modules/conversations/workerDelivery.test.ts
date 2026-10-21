import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerConversationReceiptSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeInitialTurnInput } from '../harnesses/port.js'
import { workerDeliveryFixture } from './workerDelivery.test-support.js'
import { preflightChatInput, restoreAcceptedChatInput } from './nativeChatInput.js'
import { WorkerConversationHost } from './workerHost.js'

describe('accepted cold/queued Worker inputs through the actual Main/Worker public ports', () => {
  let f: Awaited<ReturnType<typeof workerDeliveryFixture>>
  beforeEach(async () => { f = await workerDeliveryFixture() })
  afterEach(async () => { await f.close() })
  const collect = async (events: AsyncIterable<unknown>) => { for await (const event of events) void event }
  const input = (correlationId: string, prompt: string, mode: 'regular' | 'plan' = 'plan'): NativeInitialTurnInput => ({
    clientCorrelationId: correlationId, prompt, sessionMode: mode, sessionPreferences: SessionPreferencesSchema.parse({ contextBudget: 4096 }),
    onSessionObserved: async () => {},
  })

  it('preflights A/B/C before the provider SID exists and restores exact B/C frames after a Main manager replacement', async () => {
    const first = f.manager()
    const inputs = [input('A', 'Initial Plan'), input('B', 'Retained B'), input('C', 'Retained C', 'regular')]
    const accepted = await Promise.all(inputs.map(value => preflightChatInput({ content: value.prompt }, {
      workerRequired: true, prompt: value.prompt, prepare: async () => first.prepareInput({ kind: 'initial', start: f.start(value.clientCorrelationId), input: value }),
    })))
    expect(f.creates()).toBe(0)
    expect(f.frames).toEqual([])
    restoreAcceptedChatInput(first, 'A', accepted[0]!)
    const submitted: string[] = [], settings: string[] = []
    await collect(first.startInitialTurn!(f.start('A'), { ...inputs[0]!, onSubmitted: async id => { submitted.push(id) },
      onSettingsApplied: async () => { settings.push('A') } }))
    expect(submitted).toEqual(['turn-1'])
    expect(settings).toEqual(['A'])
    await first.closeForRestart(f.session)
    await first.dispose()
    const resumed = f.manager()
    await resumed.attachSession(f.session, f.start('B', 'token-two'))
    for (let index = 1; index < inputs.length; index++) {
      const next = inputs[index]!
      restoreAcceptedChatInput(resumed, next.clientCorrelationId, accepted[index]!)
      await collect(resumed.startTurn(f.session, next))
    }
    expect(f.creates()).toBe(1)
    expect(f.maximumInputs()).toBe(1)
    expect(f.inputs).toMatchObject([{ correlationId: 'A', mode: 'plan' }, { correlationId: 'B', mode: 'plan', preferences: { contextBudget: 4096 } },
      { correlationId: 'C', mode: 'regular', preferences: { contextBudget: 4096 } }])
    expect(f.frames.filter(frame => frame.method === 'conversation.initial-turn').map(frame => frame.correlationId)).toEqual(['A', 'B', 'C'])
    expect(f.credentials).toContain('token-two')
    expect((await f.journal.conversations.read(f.binding))?.appliedPreferences).toEqual(SessionPreferencesSchema.parse({ contextBudget: 4096 }))
  })

  it('retains proof across replacement and rejects prompt/settings/credential growth before any native input', async () => {
    const first = f.manager(), original = input('proof', 'The admitted input')
    const accepted = await preflightChatInput({ content: original.prompt }, { workerRequired: true, prompt: original.prompt,
      prepare: async () => first.prepareInput({ kind: 'initial', start: f.start('proof'), input: original }) })
    await first.dispose()
    for (const variant of ['prompt', 'preferences', 'credential'] as const) {
      const next = f.manager()
      restoreAcceptedChatInput(next, 'proof', accepted)
      const submit = async () => collect(next.startInitialTurn!(f.start('proof', variant === 'credential' ? 'a-larger-new-token' : 'token-one'), {
        ...original, ...(variant === 'prompt' ? { prompt: `${original.prompt}!` } : {}),
        ...(variant === 'preferences' ? { sessionPreferences: SessionPreferencesSchema.parse({ contextBudget: 8192 }) } : {}),
      }))
      await expect(submit()).rejects.toMatchObject({ code: 'CHAT_PREFLIGHT_CHANGED' })
    }
    expect(f.inputs).toEqual([])
    expect(f.creates()).toBe(0)
    expect(f.frames).toEqual([])
  })

  it('replays simultaneous original initial inputs read-only and rejects B while A has no positive closure', async () => {
    const manager = f.manager(), a = input('A', 'Original A')
    const prepared = manager.prepareInput({ kind: 'initial', start: f.start('A'), input: a }).workerFrames![0]!
    f.control({ hold: true })
    const active = collect(manager.startInitialTurn!(f.start('A'), a))
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1))
    const original = f.frames.find(frame => frame.method === 'conversation.initial-turn')!
    const [one, two] = await Promise.all([f.host.handle(original, f.connection), f.host.handle(original, f.connection)])
    expect(WorkerConversationReceiptSchema.parse((one as { receipt: unknown }).receipt).turns).toHaveLength(1)
    expect(WorkerConversationReceiptSchema.parse((two as { receipt: unknown }).receipt).turns).toHaveLength(1)
    const b = manager.prepareInput({ kind: 'initial', start: f.start('B'), input: input('B', 'B must wait') }).workerFrames![0]!
    // The live Main lease for B is deliberately independent; its original owner still cannot overlap A.
    const lease = f.bridge.capture({ request: b, channel: { binding: f.connection, request: async payload => ({ payload: await f.host.handle(payload, f.connection) }) }, current: async () => {} })
    try { await expect(lease.request()).rejects.toBeDefined() } finally { await lease.close() }
    expect(f.inputs).toHaveLength(1)
    expect(f.creates()).toBe(1)
    expect(prepared.method).toBe('conversation.initial-turn')
    f.finish('A')
    await active
  })

  it('returns the original receipt after a Worker restart without creating a writer or resending after bind-before-input failure', async () => {
    const manager = f.manager(), a = input('bind-crash', 'Never blindly resend')
    f.control({ denyAfterBind: true, dropSessionCallback: true })
    await expect(collect(manager.startInitialTurn!(f.start('bind-crash'), a))).rejects.toBeDefined()
    expect(f.creates()).toBe(1)
    expect(f.inputs).toEqual([])
    await vi.waitFor(async () => expect((await f.journal.conversations.read(f.binding))?.turns[0]?.status).toBe('uncertain'))
    const saved = await f.journal.conversations.read(f.binding)
    expect(saved?.session).toEqual(f.session)
    expect(saved?.turns).toMatchObject([{ correlationId: 'bind-crash', status: 'uncertain' }])
    f.control({ denyAfterBind: false, dropSessionCallback: false })
    const replacement = new WorkerConversationHost(f.ports)
    const frame = f.frames.find(request => request.method === 'conversation.initial-turn')!
    const lease = f.bridge.capture({ request: frame, channel: { binding: f.connection, request: async payload => ({ payload: await replacement.handle(payload, f.connection) }) }, current: async () => {} })
    try {
      const replay = await lease.request()
      expect(WorkerConversationReceiptSchema.parse((replay as { receipt: unknown }).receipt).turns).toEqual(saved?.turns)
      expect(f.creates()).toBe(1)
      expect(f.inputs).toEqual([])
    } finally { await lease.close(); await replacement.shutdown() }
  })
})
