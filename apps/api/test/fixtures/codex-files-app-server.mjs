import process from 'node:process'
// Deterministic fake app-server for the FIL-08 bridge orchestration test only.
// This is not an upstream schema fixture and never launches a model or a shell.
import assert from 'node:assert/strict'
import { createInterface } from 'node:readline'
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (request, result) => send({ id: request.id, result })
let nativeTurnId, threadId = 'thread-a', acceptedInput, resumed = false
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.method === 'initialize') reply(request, { userAgent: 'fake-codex-files' })
  else if (request.method === 'initialized') continue
  else if (request.method === 'thread/start') {
    assert.equal(request.params.config['mcp_servers.graphql.enabled'], false)
    assert.equal(request.params.developerInstructions, 'STARTUP-ONCE')
    assert.ok(request.params.dynamicTools.every((tool) => tool.type === 'function' && tool.name.startsWith('files_')))
    assert.ok(!JSON.stringify(request).includes('gql_file_'))
    reply(request, { thread: { id: threadId } })
  } else if (request.method === 'thread/resume') {
    assert.equal(request.params.threadId, threadId)
    assert.equal(Object.hasOwn(request.params, 'developerInstructions'), false)
    assert.equal(request.params.config['mcp_servers.graphql.enabled'], false)
    resumed = true; reply(request, { thread: { id: threadId } })
  } else if (request.method === 'turn/start') {
    assert.equal(request.params.threadId, threadId)
    acceptedInput = request.params.input
    assert.match(acceptedInput[0].text, /execution-only/)
    assert.ok(!JSON.stringify(request).includes('STARTUP-ONCE'))
    assert.ok(!JSON.stringify(request).includes('gql_file_'))
    nativeTurnId = 'turn-a'
    // This callback intentionally precedes the turn acknowledgement. It must be staged.
    send({ id: 'file-call-before-ack', method: 'item/tool/call', params: {
      threadId, turnId: nativeTurnId, callId: 'call-a', namespace: null,
      tool: 'files_list', arguments: { scope: request.params.testScope },
    } })
    reply(request, { turn: { id: nativeTurnId, status: 'inProgress', items: [] } })
  } else if (request.id === 'file-call-before-ack') {
    assert.equal(request.result.success, true)
    send({ id: 'foreign-turn-call', method: 'item/tool/call', params: {
      threadId, turnId: 'other-turn', callId: 'call-b', namespace: null,
      tool: 'files_list', arguments: {},
    } })
  } else if (request.id === 'foreign-turn-call') {
    assert.equal(request.result.success, false)
    send({ method: 'turn/completed', params: { threadId, turn: { id: nativeTurnId, status: 'completed', items: [] }, acceptedInput, resumed } })
  } else throw new Error(`Unexpected fake request: ${request.method ?? request.id}`)
}
