import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ClaudeBoundedQueue } from './queue.js'
import { createClaudeSdkRunner } from './runner.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from './port.js'

async function fixture() {
  const frames = new ClaudeBoundedQueue<unknown>(16)
  let prompts!: AsyncIterator<ClaudeSdkUserMessage>
  const client: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'fork' }),
    query(input) {
      prompts = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
        interrupt: async () => {}, close: () => frames.close() }
    },
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const session = await runner.open({ scope: {
    deviceId: 'device', profilePath: '/profile', configRevision: 'revision', cwd: '/work',
  }, options: {} })
  const output = session.output[Symbol.asyncIterator]()
  return {
    session,
    async offer(promptUuid: string) {
      await session.offer({ promptUuid, content: 'Continue' })
      expect((await prompts.next()).value?.uuid).toBe(promptUuid)
    },
    async emit(frame: Record<string, unknown>) {
      await frames.offer({ session_id: 'session', parent_tool_use_id: null, uuid: randomUUID(), ...frame })
      const next = await output.next()
      expect(next.done).toBe(false)
      return next.value!
    },
    close: () => runner.dispose(),
  }
}

const messageStart = (id: string, promptUuid?: string) => ({ type: 'stream_event',
  event: { type: 'message_start', message: { id } },
  ...(promptUuid ? { user_message_uuid: promptUuid } : {}) })

it('owns streamed messages across tool rounds with one input echo and no readable assistant transcript', async () => {
  const f = await fixture()
  try {
    await f.offer('input')
    for (let round = 0; round < 3; round++) {
      const id = `message-${round}`
      expect((await f.emit(messageStart(id, round === 0 ? 'input' : undefined))).observation?.promptUuids)
        .toEqual(['input'])
      expect((await f.emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'text_delta', text: 'Partial' } } })).observation?.promptUuids).toEqual(['input'])
      expect((await f.emit({ type: 'assistant', message: { id, content: [
        { type: 'tool_use', id: `tool-${round}`, name: 'Read', input: {} },
      ] } })).observation?.promptUuids).toEqual(['input'])
      await f.emit({ type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `tool-${round}`, content: 'Tool output' },
      ] } })
    }
    expect((await f.emit({ type: 'result', user_message_uuid: 'input' })).observation?.kind).toBe('result')
  } finally { await f.close() }
})

it('preserves older identities and rejects unknown snapshots, child frames and conflicting echoes', async () => {
  const f = await fixture()
  try {
    await f.offer('older')
    await f.emit(messageStart('older-message', 'older'))
    await f.emit({ type: 'result', user_message_uuid: 'older' })
    await f.offer('active')
    expect((await f.emit(messageStart('unacknowledged'))).observation).toBeUndefined()
    await f.emit(messageStart('active-message', 'active'))
    expect((await f.emit(messageStart('older-message'))).observation?.promptUuids).toEqual(['older'])
    expect((await f.emit({ type: 'assistant', message: { id: 'unknown-snapshot' } })).observation).toBeUndefined()
    expect((await f.emit({ ...messageStart('child', 'active'), parent_tool_use_id: 'parent-tool' }))
      .observation).toBeUndefined()
    expect((await f.emit(messageStart('follow-up'))).observation?.promptUuids).toEqual(['active'])
    await expect(f.emit(messageStart('older-message', 'active')))
      .rejects.toThrow('Claude response identity was reused for another input')
  } finally { await f.close() }
})

it('ends live stream ownership at a result and follows a foreign echo without granting its input a receipt', async () => {
  const f = await fixture()
  try {
    await f.offer('input')
    await f.emit(messageStart('owned', 'input'))
    await f.emit({ type: 'result', user_message_uuid: 'input' })
    expect((await f.emit(messageStart('after-result'))).observation).toBeUndefined()
    await f.offer('next')
    await f.emit(messageStart('next-message', 'next'))
    await f.emit({ type: 'result' })
    expect((await f.emit(messageStart('after-unattributed-result'))).observation).toBeUndefined()
    await f.emit(messageStart('foreign-message', 'foreign'))
    expect((await f.emit(messageStart('foreign-follow-up'))).observation?.promptUuids).toEqual(['foreign'])
    expect(f.session.reconcile('foreign')).toEqual([])
  } finally { await f.close() }
})
