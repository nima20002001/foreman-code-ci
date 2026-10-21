import { describe, expect, it } from 'vitest'
import {
  AgentSubjectSchema, BoardLifecycleFactSchema, ChatQueueCancelRequestSchema,
  ChatSendRequestSchema, ChatStopRequestSchema, EngineChatReadbackSchema,
  collaborationContractFixtures as fixture,
} from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphTransaction } from './ports.js'
import { disabledCollaborationPorts as ports } from './disabled.js'

const subject = AgentSubjectSchema.parse({ kind: 'execution', agent: fixture.agent, execution: fixture.execution })
const target = fixture.executionReadback.target
const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
  grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
// A disabled seam must not touch its owner's transaction, including on failed calls.
const transaction = new Proxy({}, { get() { throw new Error('Disabled ports must not access storage') } }) as GraphTransaction

describe('disabled collaboration ports through their public results', () => {
  it('returns an empty digest and no-effect receipts without reading a transaction', async () => {
    expect(await ports.memoryBoards.readDigest({ subject, work: fixture.work }))
      .toEqual({ text: '', cardIds: [], byteLength: 0, omittedCount: 0 })
    const result = await ports.memoryBoards.applyResultLocked(transaction, {
      subject, execution: fixture.execution, work: fixture.work, sourceEventKey: 'event',
      result: { kind: 'none', reason: 'no_changes' },
    })
    expect(result).toEqual({ applicationId: 'disabled:event', sourceEventKey: 'event',
      commandIds: [], changedCardIds: [], boardRevisions: [], replayed: false })
    const fact = BoardLifecycleFactSchema.parse({ sourceEventKey: 'launched', agent: fixture.agent,
      work: fixture.work, execution: fixture.execution, phase: 'launched', outstandingRequestIds: [], reason: null })
    expect(await ports.memoryBoards.applyLifecycleLocked(transaction, fact))
      .toMatchObject({ applicationId: 'disabled:launched', commandIds: [], changedCardIds: [], boardRevisions: [] })
  })

  it('does not acknowledge claimed effects without a command ledger', async () => {
    await expect(ports.memoryBoards.applyResultLocked(transaction, {
      subject, execution: fixture.execution, work: fixture.work, sourceEventKey: 'claimed',
      result: { kind: 'none', reason: 'already_recorded', appliedCommandIds: ['unverified-command'] },
    })).rejects.toMatchObject({ code: 'COLLABORATION_UNAVAILABLE', status: 503 })
  })

  it('leaves delivery, control and browser cleanup honestly unavailable', async () => {
    const unavailable = { code: 'COLLABORATION_UNAVAILABLE', status: 503 }
    await expect(ports.executionChat.deliver(principal,
      ChatSendRequestSchema.parse({ target, intent: 'next_turn', content: 'Keep my draft' }))).rejects.toMatchObject(unavailable)
    await expect(ports.executionChat.read(principal, { target })).rejects.toMatchObject(unavailable)
    await expect(ports.executionChat.stop(principal,
      ChatStopRequestSchema.parse({ target, scope: 'active_turn' }))).rejects.toMatchObject(unavailable)
    await expect(ports.executionChat.cancel(principal,
      ChatQueueCancelRequestSchema.parse({ target, selection: { kind: 'all' } }))).rejects.toMatchObject(unavailable)
    expect(await ports.browser.prepare({ subject, browser: { enabled: false }, computerId: 'computer', commandId: 'prepare' }))
      .toEqual({ kind: 'unavailable', reason: 'disabled', retryable: false })
    await expect(ports.browser.release({ subject, sessionId: 'session', commandId: 'release', reason: 'stop' }))
      .rejects.toMatchObject(unavailable)
  })

  it('consumes shared native readback without inventing a standalone conversation', () => {
    for (const readback of [fixture.executionReadback, fixture.consultationReadback]) {
      const parsed = EngineChatReadbackSchema.parse(readback)
      expect(parsed).toEqual(readback)
      expect(parsed.messages[0]).not.toHaveProperty('conversationId')
      expect(parsed.messages[0]).toMatchObject({ id: fixture.nativeMessage.id, sequence: '1', revision: '2' })
    }
  })
})
