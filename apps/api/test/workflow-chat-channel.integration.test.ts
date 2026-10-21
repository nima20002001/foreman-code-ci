import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowChatPostRequest } from '@foreman-code/contracts'
import { ChatDeliveryRouter } from '../src/modules/workflow-chat/delivery.js'
import { WorkflowChatService } from '../src/modules/workflow-chat/service.js'
import { channelFixture, caller, scope, target } from '../src/modules/workflow-chat/channel.test-support.js'

describe('durable Group admission through channel and delivery services', () => {
  let f: Awaited<ReturnType<typeof channelFixture>>
  beforeEach(async () => { f = await channelFixture() })
  afterEach(async () => { await f.close() })
  const mention = (commandId: string): WorkflowChatPostRequest => ({ ...scope, commandId,
    body: '  Ask @Agent and @Agent 🙂  ', mentions: [{ workflowNodeId: 'node', start: 6, end: 12 },
      { workflowNodeId: 'node', start: 17, end: 23 }], deliveries: [{ workflowNodeId: 'node', target, intent: 'auto' }], cardIds: [] })

  it('preserves exact plain post text and never wakes an owner without explicit mention chips', async () => {
    const body = '  literal @Agent is only text  '
    const result = await f.service.post(caller, { ...scope, commandId: 'plain', body, mentions: [], deliveries: [], cardIds: [] })
    expect(result.post.body).toBe(body)
    expect(result.receipts).toEqual([])
    await f.delivery.drainPrepared()
    expect(f.nativeSubmissions()).toBe(0)
    expect((await f.service.read(caller, scope, { commandId: 'plain' })).items).toEqual([result.post])
  })

  it('deduplicates repeated mentions and resumes a post-commit crash with one real owner admission', async () => {
    const input = mention('post-commit')
    const posted = await f.service.post(caller, input)
    expect(posted.receipts).toHaveLength(1)
    expect(posted.receipts[0]).toMatchObject({ requestedIntent: 'auto', appliedIntent: 'next_turn', state: 'queued' })
    f.change({ beforeAdoption: true })
    await f.delivery.drainPrepared()
    const restarted = new ChatDeliveryRouter(f.repository.deliveries, f.targetAuthority, f.owner, f.owner, f.owner)
    f.change({ beforeAdoption: false })
    await Promise.all([restarted.drainPrepared(), f.delivery.drainPrepared()])
    expect(f.nativeSubmissions()).toBe(1)
    expect((await f.service.receipts(caller, scope, { commandId: input.commandId! })).items)
      .toMatchObject([{ id: posted.receipts[0]!.id, state: 'accepted' }])
  })

  it('never resubmits after native acceptance loses its response, including public replay and restart', async () => {
    const input = { commandId: 'native-lost', target, intent: 'next_turn', content: 'Keep this exact input', attachments: [] }
    f.change({ afterNative: true })
    const receipt = await f.delivery.send(caller, input)
    expect(receipt.commandId).toBe('native-lost')
    f.change({ targetValid: false })
    expect(await f.delivery.send(caller, input)).toEqual(receipt)
    const restarted = new ChatDeliveryRouter(f.repository.deliveries, f.targetAuthority, f.owner, f.owner, f.owner)
    await restarted.drainPrepared()
    expect(f.nativeSubmissions()).toBe(1)
    const read = await restarted.read(caller, { target, commandId: 'native-lost' })
    expect(read.receipts).toEqual([receipt])
  })

  it('replays before fresh target validation but still enforces read authorization and immutable input', async () => {
    const input = mention('replay')
    const first = await f.service.post(caller, input)
    f.change({ targetValid: false })
    const restarted = new WorkflowChatService(f.repository, f.authority, f.delivery)
    expect(await restarted.post(caller, input)).toEqual({ ...first, replayed: true })
    await expect(restarted.post(caller, { ...input, body: `${input.body}!` })).rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
    f.change({ authorized: false })
    await expect(restarted.post(caller, input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rolls back the entire post when any recipient is invalid and denies agent wakeups', async () => {
    const input = mention('bad-recipient')
    const second = { kind: 'workflow_execution' as const, agent: { ...scope, workflowNodeId: 'other', agentId: 'removed' },
      execution: { runId: 'run', workflowVersionId: 'version', executionId: 'other-execution', attempt: 1 } }
    await expect(f.service.post(caller, { ...input, body: '@Agent @Other', mentions: [
      { workflowNodeId: 'node', start: 0, end: 6 }, { workflowNodeId: 'other', start: 7, end: 13 }],
      deliveries: [...input.deliveries, { workflowNodeId: 'other', target: second, intent: 'next_turn' }] }))
      .rejects.toMatchObject({ code: 'TARGET_CHANGED' })
    expect((await f.service.read(caller, scope)).items).toEqual([])
    expect((await f.service.receipts(caller, scope)).items).toEqual([])
    f.change({ agentAuthor: true })
    await expect(f.service.post(caller, mention('agent-wakeup'))).rejects.toMatchObject({ code: 'CHAT_AGENT_MENTIONS_DENIED' })
    expect(f.nativeSubmissions()).toBe(0)
  })

  it('recovers never-native direct input through exact target-bound body continuation', async () => {
    f.change({ beforeAdoption: true })
    const content = '🙂 exact retained text\n'.repeat(8_000)
    const receipt = await f.delivery.send(caller, { commandId: 'retained', target, intent: 'next_turn', content,
      attachments: [{ fileId: 'file', revisionId: 'revision' }] })
    let bodyCursor: string | undefined
    let recovered = ''
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { receiptId: receipt.id,
        ...(bodyCursor ? { bodyCursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected retained input page')
      const row = read.deliveryInputs.items[0]!
      expect(row.target).toEqual(target)
      expect(row.attachments).toEqual([{ fileId: 'file', revisionId: 'revision' }])
      recovered += row.content
      bodyCursor = row.bodyCursor ?? undefined
    } while (bodyCursor)
    expect(recovered).toBe(content)
    expect(f.nativeSubmissions()).toBe(0)
    if (target.kind !== 'workflow_execution') throw new Error('Expected execution fixture')
    await expect(f.delivery.read(caller, { target: { ...target, execution: { ...target.execution, executionId: 'wrong' } },
      deliveryInputs: { receiptId: receipt.id } })).rejects.toMatchObject({ code: 'CHAT_INPUT_NOT_FOUND' })
  })
})
