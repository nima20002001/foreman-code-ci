import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, it } from 'vitest'

import { codexRequest } from '../src/modules/harnesses/codexProtocol.js'
import { CodexStdioTransport, type JsonObject, type RpcRequest } from '../src/modules/harnesses/codexStdioTransport.js'
import { calls, fixture, fixtureProtocol, state, until } from './fixtures/codex-test-helpers.js'

describe('Codex fixtures use the pinned protocol validator', () => {
  it('validates nested client inputs and server request and response payloads', () => {
    const start = { id: 1, method: 'turn/start', params: { threadId: 'thread-1',
      clientUserMessageId: 'application-request-1', input: [{ type: 'text', text: 'hello', text_elements: [] }] } }
    assert.doesNotThrow(() => fixtureProtocol.request(start))
    assert.throws(() => fixtureProtocol.request({ ...start, params: {
      ...start.params, input: [{ type: 'text', text: 'hello', text_elements: [{ byteRange: { start: 0 } }] }],
    } }))
    const approval = { id: 2, method: 'item/commandExecution/requestApproval', params: {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'command-1', startedAtMs: 1,
      commandActions: [{ type: 'read', command: 'cat README.md', name: 'README.md', path: 'README.md' }],
    } }
    assert.doesNotThrow(() => fixtureProtocol.serverRequest(approval))
    assert.throws(() => fixtureProtocol.serverRequest({ ...approval, params: {
      ...approval.params, commandActions: [{ type: 'read', command: 42 }],
    } }))
    assert.doesNotThrow(() => fixtureProtocol.serverResponse(approval.method, { decision: 'accept' }))
    assert.throws(() => fixtureProtocol.serverResponse(approval.method, { decision: 'invented-allow' }))
    assert.throws(() => fixtureProtocol.response('model/list', { data: [{ id: 'test-model' }], nextCursor: null }))
  })
})

describe.skipIf(process.platform === 'win32')('Codex executable fixture protocol', () => {
  it('persists the interrupted turn before emitting its acknowledgement', async () => {
    const f = await fixture()
    const lines = new EventEmitter()
    const require = createRequire(import.meta.url)
    const threadId = `thread-agent-a-${process.pid}-1`
    let statusAtAcknowledgement: unknown
    try {
      const source = await readFile(new URL('./fixtures/codex-app-server.cjs', import.meta.url), 'utf8')
      // Capture state synchronously at stdout emission so process scheduling cannot hide an early ACK.
      runInNewContext(source, {
        __dirname: f.directory,
        require: (name: string) => name === 'node:readline' ? { createInterface: () => lines } : require(name),
        process: {
          argv: [process.execPath, f.binary, 'app-server'],
          env: {},
          pid: process.pid,
          stdin: new EventEmitter(),
          on: () => {},
          cwd: () => f.directory,
          stdout: { write: (frame: string) => {
            const message = JSON.parse(frame) as JsonObject
            if (message.id === 3) {
              const snapshot = JSON.parse(readFileSync(join(f.directory, `state-${threadId}.json`),
                'utf8')) as { turns: JsonObject[] }
              statusAtAcknowledgement = snapshot.turns[0]!.status
            }
            return true
          } },
        },
        setInterval: () => {},
      })
      lines.emit('line', JSON.stringify({ id: 1, method: 'thread/start', params: { cwd: f.directory } }))
      lines.emit('line', JSON.stringify({ id: 2, method: 'turn/start', params: { threadId,
        input: [{ type: 'text', text: 'wait', text_elements: [] }] } }))
      lines.emit('line', JSON.stringify({ id: 3, method: 'turn/interrupt', params: { threadId, turnId: 'turn-1' } }))
      assert.equal(statusAtAcknowledgement, 'interrupted')
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it('publishes complete persisted snapshots while a thread receives repeated input', async () => {
    const f = await fixture()
    const transport = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, fixtureProtocol,
      async () => undefined, () => undefined, () => undefined,
    )
    try {
      await transport.start()
      const thread = await codexRequest(transport, 'thread/start', { cwd: f.directory })
      const turn = await codexRequest(transport, 'turn/start', { threadId: thread.thread.id,
        input: [{ type: 'text', text: 'wait', text_elements: [] }], clientUserMessageId: 'initial-input' })
      for (let index = 0; index < 8; index += 1) {
        const sending = codexRequest(transport, 'turn/steer', { threadId: thread.thread.id,
          expectedTurnId: turn.turn.id, clientUserMessageId: `input-${index}`,
          input: [{ type: 'text', text: 'x'.repeat(16_384), text_elements: [] }] })
        await state(f.directory, thread.thread.id)
        await sending
        const snapshot = await state(f.directory, thread.thread.id)
        assert.equal(snapshot.id, thread.thread.id)
        assert.equal(snapshot.turns[0]!.id, turn.turn.id)
        assert.equal(snapshot.turns[0]!.status, 'inProgress')
        assert.equal((snapshot.turns[0]!.items as JsonObject[]).length, index + 2)
      }
    } finally {
      await transport.close()
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it('targets each thread independently and paginates its items while preserving resume settings', async () => {
    const f = await fixture()
    const notifications: Array<{ method: string; params: JsonObject }> = []
    const transport = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, fixtureProtocol,
      async () => undefined,
      (method, params) => notifications.push({ method, params }),
      () => undefined,
    )
    try {
      await transport.start()
      const root = await codexRequest(transport, 'thread/start', { cwd: f.directory, model: 'root-model' })
      const child = await codexRequest(transport, 'thread/start', { cwd: f.directory, model: 'child-model',
        approvalPolicy: 'never', sandbox: 'danger-full-access', config: { model_reasoning_effort: 'low' } })
      const rootTurn = await codexRequest(transport, 'turn/start', { threadId: root.thread.id,
        input: [{ type: 'text', text: 'wait', text_elements: [] }], clientUserMessageId: 'root-request' })
      const childTurn = await codexRequest(transport, 'turn/start', { threadId: child.thread.id,
        input: [{ type: 'text', text: 'wait', text_elements: [] }], clientUserMessageId: 'child-request' })
      await codexRequest(transport, 'turn/steer', { threadId: child.thread.id, expectedTurnId: childTurn.turn.id,
        input: [{ type: 'text', text: 'steer', text_elements: [] }], clientUserMessageId: 'child-steer' })
      const firstPage = await codexRequest(transport, 'thread/items/list', {
        threadId: child.thread.id, turnId: childTurn.turn.id, sortDirection: 'asc', limit: 1,
      })
      assert.equal(firstPage.data[0]!.turnId, childTurn.turn.id)
      assert(firstPage.nextCursor)
      const secondPage = await codexRequest(transport, 'thread/items/list', {
        threadId: child.thread.id, turnId: childTurn.turn.id, sortDirection: 'asc', limit: 1,
        cursor: firstPage.nextCursor,
      })
      assert.equal(secondPage.nextCursor, null)
      const items = [firstPage.data[0]!.item, secondPage.data[0]!.item]
      assert.deepEqual(items.filter((item) => item.type === 'userMessage').map((item) => item.clientId),
        ['child-request', 'child-steer'])
      const rootItems = await codexRequest(transport, 'thread/items/list', { threadId: root.thread.id })
      assert.equal(rootItems.data.length, 1)
      assert.equal(rootItems.data[0]!.turnId, rootTurn.turn.id)
      await codexRequest(transport, 'turn/interrupt', { threadId: child.thread.id, turnId: childTurn.turn.id })
      await until(async () => notifications.some((entry) => entry.method === 'turn/completed'
        && entry.params.threadId === child.thread.id))
      assert.equal((await state(f.directory, root.thread.id)).turns[0]!.status, 'inProgress')
      assert.equal((await state(f.directory, child.thread.id)).turns[0]!.status, 'interrupted')
      const resumed = await codexRequest(transport, 'thread/resume', { threadId: child.thread.id, excludeTurns: true })
      assert.equal(resumed.model, 'child-model')
      assert.equal(resumed.approvalPolicy, 'never')
      assert.equal(resumed.reasoningEffort, 'low')
      assert.deepEqual(resumed.sandbox, { type: 'dangerFullAccess' })
    } finally {
      await transport.close()
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it('retains each approval owner when another thread starts and receives input', async () => {
    const f = await fixture()
    const requests: RpcRequest[] = []
    const transport = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, fixtureProtocol,
      async (request) => { requests.push(request) }, () => undefined, () => undefined,
    )
    try {
      await transport.start()
      const first = await codexRequest(transport, 'thread/start', { cwd: f.directory })
      const firstTurn = await codexRequest(transport, 'turn/start', { threadId: first.thread.id,
        input: [{ type: 'text', text: 'approval', text_elements: [] }], clientUserMessageId: 'first-request' })
      await until(async () => requests.length === 1)
      const second = await codexRequest(transport, 'thread/start', { cwd: f.directory })
      await codexRequest(transport, 'turn/start', { threadId: second.thread.id,
        input: [{ type: 'text', text: 'approval', text_elements: [] }], clientUserMessageId: 'second-request' })
      await until(async () => requests.length === 2)
      assert.notEqual(requests[0]!.id, requests[1]!.id)
      await codexRequest(transport, 'turn/steer', { threadId: first.thread.id, expectedTurnId: firstTurn.turn.id,
        input: [{ type: 'text', text: 'steer', text_elements: [] }], clientUserMessageId: 'first-steer' })
      await transport.respond(requests[0]!.id, requests[0]!.method, { decision: 'accept' })
      await until(async () => (await state(f.directory, first.thread.id)).turns[0]!.status === 'completed')
      assert.equal((await state(f.directory, second.thread.id)).turns[0]!.status, 'inProgress')
      const readback = await codexRequest(transport, 'thread/read', { threadId: first.thread.id, includeTurns: true })
      const messages = readback.thread.turns[0]!.items.filter((item) => item.type === 'userMessage')
      assert.deepEqual(messages.map((item) => item.clientId), ['first-request', 'first-steer'])
      await transport.respond(requests[1]!.id, requests[1]!.method, { decision: 'accept' })
      await until(async () => (await state(f.directory, second.thread.id)).turns[0]!.status === 'completed')
    } finally {
      await transport.close()
      await rm(f.directory, { recursive: true, force: true })
    }
  })

  it('validates live fixture frames and preserves distinct native and application IDs after restart', async () => {
    const f = await fixture()
    const transports: CodexStdioTransport[] = []
    const notifications: Array<{ method: string; params: JsonObject }> = []
    const approvals: RpcRequest[] = []
    const connect = async () => {
      const value = new CodexStdioTransport(f.binary, f.directory, { ...process.env }, fixtureProtocol,
        async (request) => {
          approvals.push(request)
          await value.respond(request.id, request.method, { decision: 'accept' })
        },
        (method, params) => notifications.push({ method, params }),
        () => undefined,
      )
      transports.push(value)
      await value.start()
      return value
    }
    try {
      const first = await connect()
      const created = await codexRequest(first, 'thread/start', { cwd: f.directory, model: 'test-model' })
      const threadId = created.thread.id
      await codexRequest(first, 'config/read', { includeLayers: true })
      await codexRequest(first, 'model/list', {})
      await codexRequest(first, 'mcpServerStatus/list', {})
      const started = await codexRequest(first, 'turn/start', { threadId, clientUserMessageId: 'application-request-1',
        input: [{ type: 'text', text: 'wait', text_elements: [] }] })
      await codexRequest(first, 'turn/steer', { threadId, expectedTurnId: started.turn.id,
        clientUserMessageId: 'application-request-2', input: [{ type: 'text', text: 'steer', text_elements: [] }] })
      await first.close()

      const restarted = await connect()
      const resumed = await codexRequest(restarted, 'thread/resume', { threadId, cwd: f.directory })
      assert.equal(resumed.thread.id, threadId)
      const readback = await codexRequest(restarted, 'thread/read', { threadId, includeTurns: true })
      const turn = readback.thread.turns[0]!
      assert.equal(turn.id, started.turn.id)
      const userMessages = turn.items.filter((item) => item.type === 'userMessage')
      assert.deepEqual(userMessages.map((item) => item.clientId), ['application-request-1', 'application-request-2'])
      assert.equal(new Set(userMessages.map((item) => item.id)).size, 2)
      for (const item of userMessages) assert.notEqual(item.id, item.clientId)
      const page = await codexRequest(restarted, 'thread/turns/list', { threadId })
      assert.deepEqual(page.data, readback.thread.turns)
      await codexRequest(restarted, 'turn/interrupt', { threadId, turnId: turn.id })
      await until(async () => notifications.some((entry) => entry.method === 'turn/completed'))

      const approved = await codexRequest(restarted, 'turn/start', { threadId,
        input: [{ type: 'text', text: 'approval', text_elements: [] }], clientUserMessageId: 'application-request-3' })
      await until(async () => notifications.some((entry) => entry.method === 'turn/completed'
        && (entry.params.turn as JsonObject).id === approved.turn.id))
      assert.equal(approvals.length, 1)
      assert.equal(approvals[0]!.params!.threadId, threadId)
      assert(notifications.some((entry) => entry.method === 'serverRequest/resolved'))
      assert(notifications.some((entry) => entry.method === 'item/completed'))
      const logged = await calls(f.directory)
      assert.equal(logged.filter((entry) => (entry.wire as JsonObject | undefined)?.method === 'thread/start').length, 1)
      assert.equal(logged.filter((entry) => (entry.wire as JsonObject | undefined)?.method === 'turn/start').length, 2)
    } finally {
      await Promise.all(transports.map((value) => value.close()))
      await rm(f.directory, { recursive: true, force: true })
    }
  })
})
