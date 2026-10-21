import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelFixture, caller, scope, target } from '../src/modules/workflow-chat/channel.test-support.js'
import type { RetainedDeliveryInput } from '../src/modules/workflow-chat/retainedInputs.js'

describe('bounded channel/readback and global command identity through public services', () => {
  let f: Awaited<ReturnType<typeof channelFixture>>
  beforeEach(async () => { f = await channelFixture() })
  afterEach(async () => { await f.close() })

  it('budgets the complete escaped/multibyte history envelope and traverses every retained post exactly once', async () => {
    const body = '🙂"\\\n'.repeat(1800)
    const ids: string[] = []
    for (let index = 0; index < 30; index++) ids.push((await f.service.post(caller, { ...scope, commandId: `page-${index}`,
      body, mentions: [], deliveries: [], cardIds: [] })).post.id)
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await f.service.read(caller, scope, { limit: 100, ...(cursor ? { cursor } : {}) })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024)
      expect(page.items.every(post => post.body === body)).toBe(true)
      seen.push(...page.items.map(post => post.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(seen)).toEqual(new Set(ids))
    expect(seen).toHaveLength(ids.length)
  })

  it('budgets retained input pages including continuation metadata and recovers exact never-native content', async () => {
    f.change({ beforeAdoption: true })
    const content = '🙂"\\\n'.repeat(10_000)
    const ids: string[] = []
    for (let index = 0; index < 20; index++) ids.push((await f.delivery.send(caller, { target, commandId: `input-${index}`,
      intent: 'next_turn', content })).id)
    const rows: RetainedDeliveryInput[] = []
    let cursor: string | undefined
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { limit: 100, ...(cursor ? { cursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected retained input page.')
      expect(Buffer.byteLength(JSON.stringify(read.deliveryInputs))).toBeLessThanOrEqual(256 * 1024)
      rows.push(...read.deliveryInputs.items); cursor = read.deliveryInputs.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(rows.map(row => row.receiptId))).toEqual(new Set(ids))
    let recovered = '', bodyCursor: string | undefined
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { receiptId: ids[0], ...(bodyCursor ? { bodyCursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected exact input page.')
      const row = read.deliveryInputs.items[0]!
      recovered += row.content; bodyCursor = row.bodyCursor ?? undefined
    } while (bodyCursor)
    expect(recovered).toBe(content)
    expect(f.nativeSubmissions()).toBe(0)
  })

  it('conflicts on the same actor command across workflows and between Group posts and direct sends', async () => {
    const request = { ...scope, commandId: 'global-command', body: 'Original plain post', mentions: [], deliveries: [], cardIds: [] }
    const events: unknown[] = []
    const unsubscribe = f.service.events.subscribe(scope.workflowId, event => events.push(event))
    try {
      const first = await f.service.post(caller, request)
      expect(await f.service.post(caller, request)).toEqual({ ...first, replayed: true })
      expect(events).toHaveLength(1)
      await expect(f.service.post(caller, { ...request, workflowId: 'other-workflow' })).rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
      await expect(f.delivery.send(caller, { target, commandId: request.commandId, intent: 'next_turn', content: request.body }))
        .rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
      const direct = await f.delivery.send(caller, { target, commandId: 'direct-command', intent: 'next_turn', content: 'Direct' })
      await expect(f.service.post(caller, { ...request, commandId: direct.commandId })).rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
      expect((await f.service.read(caller, { ...scope, workflowId: 'other-workflow' })).items).toEqual([])
      expect(events).toHaveLength(1)
    } finally { unsubscribe() }
  })
})
