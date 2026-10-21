import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import type { AgentIdentity, BoardLifecycleFact, WorkflowChatPostRequest } from '@foreman-code/contracts'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { WorkflowChatProjector, type CommittedWorkflowChatFact, type CommittedReplySource } from '../src/modules/workflow-chat/projection.js'
import { channelFixture, caller, scope, target } from '../src/modules/workflow-chat/channel.test-support.js'

describe('committed Group projection through durable public seams', () => {
  let f: Awaited<ReturnType<typeof channelFixture>>
  beforeEach(async () => { f = await channelFixture() })
  afterEach(async () => { await f.close() })
  const agent: AgentIdentity = { ...scope, workflowNodeId: 'node', agentId: 'agent', configurationVersionId: 'configuration', displayName: 'Agent', productRole: 'coder' }
  const execution = { runId: 'run', workflowVersionId: 'version', executionId: 'execution', activationId: 'activation', attempt: 1 }
  const work = { kind: 'activation' as const, runId: 'run', workflowVersionId: 'version', activationId: 'activation' }
  const fact = (key: string, phase: BoardLifecycleFact['phase'], changes: Partial<BoardLifecycleFact> = {}): Extract<CommittedWorkflowChatFact, { kind: 'lifecycle' }> => ({
    kind: 'lifecycle', sourceEventKey: key, agent, createdAt: '2026-10-01T00:00:00.000Z', fact: {
      sourceEventKey: key, agent, work, execution, phase, outstandingRequestIds: [], reason: null, ...changes,
    },
  })
  const post = (commandId: string): WorkflowChatPostRequest => ({ ...scope, commandId, body: '@Agent answer this exact post', mentions: [
    { workflowNodeId: 'node', start: 0, end: 6 }], deliveries: [{ workflowNodeId: 'node', target, intent: 'next_turn' }], cardIds: [] })
  const enqueue = (projector: WorkflowChatProjector, value: CommittedWorkflowChatFact) =>
    withTransaction(f.pool, tx => projector.enqueueCommitted(tx, value))

  it('projects one logical Started/Finished, honest failure and changed blockers, and discovers delayed smaller source keys after restart', async () => {
    const events: unknown[] = []
    const create = () => new WorkflowChatProjector(f.repository, (_id, event) => events.push(event), { read: async () => undefined })
    let projector = create()
    const started = fact('z-100-start', 'launched')
    await enqueue(projector, started); await projector.projectCommittedFacts()
    await enqueue(projector, fact('z-101-failed', 'failed', { reason: "Agent's task failed." }))
    await enqueue(projector, fact('z-102-same-blocker', 'failed', { reason: "Agent's task failed." }))
    await enqueue(projector, fact('z-103-new-blocker', 'blocked', { reason: 'A required review is unavailable.' }))
    await projector.projectCommittedFacts()
    await enqueue(projector, fact('z-104-retry', 'retry_admitted'))
    await enqueue(projector, fact('z-105-retry-launched', 'launched', { execution: { ...execution, executionId: 'retry', attempt: 2 } }))
    await enqueue(projector, fact('z-106-waiting', 'waiting_children', { outstandingRequestIds: ['child'] }))
    await expect(enqueue(projector, fact('invalid-acceptance', 'accepted', { outstandingRequestIds: ['child'] })))
      .rejects.toBeInstanceOf(ZodError)
    await enqueue(projector, fact('z-107-intermediate', 'awaiting_acceptance', { outstandingRequestIds: ['child'] }))
    await projector.projectCommittedFacts()
    expect((await f.service.read(caller, scope)).items.filter(item => item.kind === 'finished')).toEqual([])
    await enqueue(projector, { ...fact('z-108-final', 'accepted'), summary: 'The exact logical work was accepted.' })
    await projector.projectCommittedFacts()
    const beforeReplay = events.length
    projector = create()
    await enqueue(projector, started)
    await projector.projectCommittedFacts()
    expect(events).toHaveLength(beforeReplay)
    await enqueue(projector, fact('a-001-delayed-commit', 'failed', { work: { ...work, activationId: 'delayed' }, execution: { ...execution, activationId: 'delayed' }, reason: 'Preparation failed before any native submission.' }))
    await projector.projectCommittedFacts()
    const page = await f.service.read(caller, scope)
    expect(page.items.filter(item => item.kind === 'started')).toHaveLength(1)
    expect(page.items.filter(item => item.kind === 'finished')).toHaveLength(1)
    expect(page.items.filter(item => item.kind === 'blocked').map(item => item.body)).toEqual([
      "Agent's task failed.", 'A required review is unavailable.', 'Preparation failed before any native submission.',
    ])
    expect(page.items.some(item => item.sourceEventKey === 'a-001-delayed-commit')).toBe(true)
  })

  it('keeps continuation admission silent and preserves a genuine successor preparation failure', async () => {
    const projector = new WorkflowChatProjector(f.repository, () => {}, { read: async () => undefined })
    await expect(enqueue(projector, fact('superseded', 'canceled', { controlContinuationId: 'continuation',
      previousExecution: execution, reason: 'This attempt was superseded.' }))).rejects.toBeInstanceOf(ZodError)
    expect((await f.service.read(caller, scope)).items).toEqual([])
    await enqueue(projector, fact('continuing', 'continuation_admitted', { controlContinuationId: 'continuation', previousExecution: execution,
      execution: { ...execution, executionId: 'successor', attempt: 2 } }))
    await enqueue(projector, fact('successor-failed', 'failed', {
      execution: { ...execution, executionId: 'successor', attempt: 2 }, reason: 'The successor could not prepare its accepted profile.' }))
    await projector.projectCommittedFacts()
    expect((await f.service.read(caller, scope)).items).toMatchObject([{ kind: 'blocked', sourceEventKey: 'successor-failed' }])
  })

  it('finds an earlier source transaction that commits after a later projection and process replacement', async () => {
    const create = () => new WorkflowChatProjector(f.repository, () => {}, { read: async () => undefined })
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const projector = create()
    const delayed = withTransaction(f.pool, async tx => {
      await projector.enqueueCommitted(tx, fact('a-earlier-transaction', 'failed', { work: { ...work, activationId: 'older' }, execution: { ...execution, activationId: 'older' }, reason: 'Earlier committed fact' }))
      entered()
      await held
    })
    try {
      await Promise.race([ready, delayed])
      await enqueue(projector, fact('z-later-transaction', 'launched'))
      await projector.projectCommittedFacts()
      expect((await f.service.read(caller, scope)).items.map(item => item.sourceEventKey)).toEqual(['z-later-transaction'])
      release(); await delayed
      await create().projectCommittedFacts()
      expect((await f.service.read(caller, scope)).items.map(item => item.sourceEventKey)).toEqual(['z-later-transaction', 'a-earlier-transaction'])
    } finally { release(); await delayed }
  })

  it('links an exact committed reply once even after terminal receipt settlement and excludes direct replies', async () => {
    const source: CommittedReplySource = { read: async (_tx, input) => ({ body: `Answer from ${input.nativeMessageId}` }) }
    const projector = new WorkflowChatProjector(f.repository, () => {}, source)
    const posted = await f.service.post(caller, post('exact-group'))
    await f.delivery.drainPrepared()
    const receipt = (await f.service.receipts(caller, scope)).items[0]!
    await f.repository.deliveries.update({ ...receipt, state: 'completed', updatedAt: new Date().toISOString() })
    const reply: CommittedWorkflowChatFact = { kind: 'reply', sourceEventKey: 'exact-native-reply', agent,
      createdAt: new Date().toISOString(), commandId: receipt.commandId, receiptId: receipt.id, execution,
      nativeMessageId: 'native-answer', nativeSessionId: `session:${receipt.commandId}`, nativeTurnId: `native:${receipt.commandId}` }
    await enqueue(projector, reply); await projector.projectCommittedFacts()
    await enqueue(projector, reply); await projector.projectCommittedFacts()
    await enqueue(projector, { ...reply, sourceEventKey: 'duplicate-observation' }); await projector.projectCommittedFacts()
    const page = await f.service.read(caller, scope)
    const answers = page.items.filter(item => item.replyToPostId === posted.post.id)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ body: 'Answer from native-answer', execution })
    expect((await f.service.receipts(caller, scope)).items[0]).toMatchObject({ state: 'completed', replyPostId: answers[0]!.id })
    const direct = await f.delivery.send(caller, { target, commandId: 'direct-private', intent: 'next_turn', content: 'Private input' })
    await enqueue(projector, { ...reply, sourceEventKey: 'direct-native-reply', commandId: direct.commandId, receiptId: direct.id,
      nativeSessionId: `session:${direct.commandId}`, nativeTurnId: `native:${direct.commandId}` })
    await projector.projectCommittedFacts()
    expect((await f.service.read(caller, scope)).items).toEqual(page.items)
  })

  it.each(['session', 'execution', 'consultation'] as const)('rejects a reply with different %s provenance instead of guessing from the latest node', async field => {
    const projector = new WorkflowChatProjector(f.repository, () => {}, { read: async () => ({ body: 'Must not leak' }) })
    await f.service.post(caller, post(`wrong-${field}`)); await f.delivery.drainPrepared()
    const receipt = (await f.service.receipts(caller, scope)).items[0]!
    await enqueue(projector, { kind: 'reply', sourceEventKey: `bad-${field}`, agent, createdAt: new Date().toISOString(),
      commandId: receipt.commandId, receiptId: receipt.id, nativeMessageId: 'answer',
      nativeSessionId: field === 'session' ? 'foreign-session' : `session:${receipt.commandId}`, nativeTurnId: `native:${receipt.commandId}`,
      execution: field === 'execution' ? { ...execution, executionId: 'foreign-execution' } : execution,
      ...(field === 'consultation' ? { consultationId: 'foreign-consultation' } : {}) })
    await expect(projector.projectCommittedFacts()).rejects.toMatchObject({ code: 'CHAT_REPLY_TARGET_MISMATCH' })
    expect((await f.service.read(caller, scope)).items).toHaveLength(1)
  })

  it('keeps an oversized exact native reply visible and recovers every code point through bounded body continuation', async () => {
    const body = '🙂"\\\n'.repeat(60_000)
    const projector = new WorkflowChatProjector(f.repository, () => {}, { read: async () => ({ body }) })
    const posted = await f.service.post(caller, post('large-answer')); await f.delivery.drainPrepared()
    const receipt = (await f.service.receipts(caller, scope)).items[0]!
    await enqueue(projector, { kind: 'reply', sourceEventKey: 'large-exact-reply', agent, execution, createdAt: new Date().toISOString(),
      commandId: receipt.commandId, receiptId: receipt.id, nativeMessageId: 'large-answer',
      nativeSessionId: `session:${receipt.commandId}`, nativeTurnId: `native:${receipt.commandId}` })
    await projector.projectCommittedFacts()
    const page = await f.service.read(caller, scope)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
    const latest = page.items.at(-1)!
    expect(latest.replyToPostId).toBe(posted.post.id)
    expect(page.bodyTruncations).toMatchObject([{ postId: latest.id, originalBytes: Buffer.byteLength(body) }])
    let recovered = '', cursor: string | undefined
    do {
      const chunk = await f.service.body(caller, scope, latest.id, cursor)
      expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(256 * 1024)
      recovered += chunk.body; cursor = chunk.nextBodyCursor ?? undefined
    } while (cursor)
    expect(recovered).toBe(body)
  })
})
