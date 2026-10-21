import { expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import type { NativeHarnessSessionManager, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { memoryConversation, operator } from './fixtures/agent1OperatorChat.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'

function setup(ids: string[]) {
  const f = workerConversationFixture()
  if (!('operatorId' in f.configuration)) throw new Error('Operator configuration required')
  const configuration = f.configuration
  const principal = operator()
  const conversations = ids.map(id => {
    const conversation = memoryConversation(configuration, principal.id, id)
    Object.assign(conversation.row, { native_session_id: f.session.nativeSessionId, provider_version: f.session.providerVersion,
      active_request_id: 'request', active_phase: 'submitted', active_native_turn_id: 'native-turn', turn_state: 'active' })
    return conversation
  })
  const find = (id: string) => {
    const conversation = conversations.find(value => value.row.id === id)
    if (!conversation) throw new Error('Unknown conversation')
    return conversation
  }
  const repository = new Proxy(conversations[0]!.repository, { get(target, name) {
    if (name === 'unfinished') return async () => conversations.filter(value => value.row.active_request_id)
      .map(value => structuredClone(value.row))
    const member = Reflect.get(target, name)
    if (typeof member !== 'function' || ['configuration', 'createSessionControls', 'createControlCommands'].includes(String(name))) return member
    return (id: string, ...args: unknown[]) => Reflect.get(find(id).repository, name).call(find(id).repository, id, ...args)
  } }) as PostgresOperatorConversationRepository
  const attached: string[] = []
  const closed: string[] = []
  const recovered: NativeSessionStart[] = []
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const managers = (_configuration: unknown, id: string) => ({
    harness: 'codex', attachSession: async (session: unknown) => {
      attached.push(id)
      if (id.startsWith('slow')) await gate
      return session
    },
    reconcileSessionCreation: async (start: NativeSessionStart) => { recovered.push(start); return f.session },
    reconcile: async () => ({ events: [], pendingInteractions: [], correlationId: nativeCorrelation(id, 'request'),
      nativeTurnId: 'native-turn', terminalResult: { outcome: 'succeeded' } }),
    closeForResume: async (session: unknown) => {
      expect(session).toEqual(f.session)
      closed.push(id)
    },
    dispose: async () => {}, stopAutomaticResponses: () => {},
  }) as unknown as NativeHarnessSessionManager
  const authority = { current: async () => principal, release: async () => {},
    prepare: async () => { throw new Error('Recovery must not issue a launch credential') } }
  const chat = new OperatorChatService(repository, {} as never, managers as never, '/runtime/operator', authority as never)
  return { chat, conversations, attached, closed, recovered, unblock, f }
}

it('recovers healthy conversations while another computer is stalled, with a bounded recovery pool', async () => {
  const f = setup(['slow', 'healthy', 'local', 'another', 'queued'])
  const recovering = f.chat.reconcileActive()
  try {
    for (let index = 0; index < 200; index++) await Promise.resolve()
    expect(f.conversations.find(value => value.row.id === 'healthy')!.finishResults)
      .toEqual([{ outcome: 'succeeded' }])
    expect(f.attached).toContain('local')
  } finally { f.unblock(); await recovering; await f.chat.shutdown() }
})

it('looks up the original Worker creation after a Main restart without issuing a new credential or session', async () => {
  const f = setup(['recovering'])
  Object.assign(f.conversations[0]!.row, { native_session_id: null, provider_version: null,
    active_phase: 'creating', active_native_turn_id: null })
  try {
    await f.chat.reconcileActive()
    expect(f.recovered).toMatchObject([{ kind: 'operator', configuration: f.f.configuration,
      correlationId: nativeCorrelation('recovering', 'request') }])
    expect(f.conversations[0]!.row.native_session_id).toBe(f.f.session.nativeSessionId)
    expect(f.conversations[0]!.finishResults).toHaveLength(1)
  } finally { await f.chat.shutdown() }
})

it('admits at most four independent recovery operations at once', async () => {
  const f = setup(Array.from({ length: 6 }, (_, index) => `slow-${index}`))
  const recovering = f.chat.reconcileActive()
  try {
    for (let index = 0; index < 200; index++) await Promise.resolve()
    expect(f.attached).toHaveLength(4)
  } finally { f.unblock(); await recovering; await f.chat.shutdown() }
})

it('closes only the recovered Worker owner while retaining its session and original turn result', async () => {
  const f = setup(['healthy'])
  try {
    await f.chat.reconcileActive()
    expect(f.closed).toEqual(['healthy'])
    expect(f.attached).toEqual(['healthy'])
    expect(f.recovered).toEqual([])
    expect(f.conversations[0]!.row.native_session_id).toBe(f.f.session.nativeSessionId)
    expect(f.conversations[0]!.finishResults).toEqual([{ outcome: 'succeeded' }])
  } finally { await f.chat.shutdown() }
})
