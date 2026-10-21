import assert from 'node:assert/strict'

import { it } from 'vitest'

import { protocolFromBundle } from '../src/modules/harnesses/codexProtocol.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'

/**
 * Small schema fixture to exercise the actual Zod converter and protocol decoder.
 * It is NOT claimed as the installed Codex manifest. The live qualification test
 * separately compiles the installation's measured, version-gated bundle.
 */
function bundle(): JsonObject {
  const responses: Record<string, string> = {
    initialize: 'InitializeResponse', 'thread/start': 'ThreadStartResponse', 'thread/resume': 'ThreadResumeResponse',
    'thread/read': 'ThreadReadResponse', 'thread/turns/list': 'ThreadTurnsListResponse', 'thread/items/list': 'ThreadItemsListResponse',
    'turn/start': 'TurnStartResponse', 'turn/interrupt': 'TurnInterruptResponse', 'turn/steer': 'TurnSteerResponse', 'thread/fork': 'ThreadForkResponse', 'config/read': 'ConfigReadResponse',
    'config/batchWrite': 'ConfigWriteResponse', 'model/list': 'ModelListResponse', 'mcpServerStatus/list': 'ListMcpServerStatusResponse',
    'account/login/start': 'LoginAccountResponse', 'account/login/cancel': 'CancelLoginAccountResponse',
  }
  const serverResponses: Record<string, string> = {
    'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
    'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
    'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
    'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
    'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
  }
  const v2: JsonObject = {}
  for (const name of [...Object.values(responses), ...Object.values(serverResponses)]) v2[name] = { type: 'object' }
  v2.Turn = {
    type: 'object', required: ['id', 'items', 'status'], properties: {
      id: { type: 'string', minLength: 1 }, items: { type: 'array', items: { type: 'object' } },
      status: { enum: ['inProgress', 'completed', 'failed', 'interrupted'] },
    },
  }
  v2.TurnStartResponse = { type: 'object', required: ['turn'], properties: { turn: { $ref: '#/definitions/v2/Turn' } } }
  v2.CommandExecutionRequestApprovalResponse = {
    type: 'object', required: ['decision'], properties: { decision: { enum: ['accept', 'acceptForSession', 'decline', 'cancel'] } },
  }
  const envelope = (method: string, notification = false): JsonObject => ({
    type: 'object', required: notification ? ['method', 'params'] : ['id', 'method'],
    properties: {
      method: { enum: [method] }, id: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
      params: notification ? { type: 'object', required: ['threadId', 'turn'], properties: {
        threadId: { type: 'string', minLength: 1 }, turn: { $ref: '#/definitions/v2/Turn' },
      } } : { type: 'object' },
    },
  })
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    v2,
    ClientRequest: { oneOf: Object.keys(responses).map((method) => envelope(method)) },
    ServerRequest: { oneOf: Object.keys(serverResponses).map((method) => envelope(method)) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map((method) => envelope(method, true)) },
  } }
}

it('F28: generated-schema references validate payloads rather than merely reporting a constant hash', () => {
  const protocol = protocolFromBundle(bundle())
  const turn = { id: 'turn-1', items: [], status: 'completed' }
  protocol.response('turn/start', { turn })
  protocol.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn } })
  protocol.serverResponse('item/commandExecution/requestApproval', { decision: 'decline' })
  assert.throws(() => protocol.response('turn/start', { turn: { id: '', items: [], status: 'completed' } }))
  assert.throws(() => protocol.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'wrong' } } }))
  assert.throws(() => protocol.serverResponse('item/commandExecution/requestApproval', { decision: 'invented-allow' }))
  assert.throws(() => protocol.request({ id: 1, method: 'unqualified/mutation', params: {} }))
})

it('F28: incomplete generated bundles fail qualification before execution', () => {
  assert.throws(() => protocolFromBundle({ definitions: {} }))
})

it('accepts dynamic tool responses when real bundles keep DynamicToolCallResponse at the top level beside v2', () => {
  // codex-cli 0.156.1/0.158.0 generate exactly this layout; a v2-only lookup rejected every real file-tool reply.
  const value = bundle()
  const definitions = value.definitions as JsonObject
  const serverRequest = definitions.ServerRequest as { oneOf: JsonObject[] }
  serverRequest.oneOf.push({ type: 'object', required: ['id', 'method'], properties: {
    method: { enum: ['item/tool/call'] }, id: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, params: { type: 'object' } } })
  definitions.DynamicToolCallResponse = { type: 'object', required: ['contentItems', 'success'], properties: {
    success: { type: 'boolean' },
    contentItems: { type: 'array', items: { type: 'object', required: ['type', 'text'], properties: {
      type: { enum: ['inputText'] }, text: { type: 'string' } } } } } }
  const protocol = protocolFromBundle(value)
  protocol.serverResponse('item/tool/call', { success: true, contentItems: [{ type: 'inputText', text: '{}' }] })
  assert.throws(() => protocol.serverResponse('item/tool/call', { success: true }))
})

it('validates escaped and recursive references through every referenced definition', () => {
  const value = bundle()
  const definitions = value.definitions as JsonObject
  const v2 = definitions.v2 as JsonObject
  const turn = v2.Turn as JsonObject
  const properties = turn.properties as JsonObject
  properties.metadata = { $ref: '#/definitions/Metadata~1Label~0' }
  definitions['Metadata/Label~'] = {
    type: 'object', required: ['label'], properties: {
      label: { type: 'string', minLength: 1 },
      child: { $ref: '#/definitions/Metadata~1Label~0' },
    },
  }
  const protocol = protocolFromBundle(value)
  const result = { turn: { id: 'turn-1', items: [], status: 'completed',
    metadata: { label: 'parent', child: { label: 'child' } } } }
  assert.doesNotThrow(() => protocol.response('turn/start', result))
  result.turn.metadata.child.label = ''
  assert.throws(() => protocol.response('turn/start', result))
})

it('uses changed referenced constraints even when the schema object and provider version are reused', () => {
  const value = bundle()
  const original = protocolFromBundle(value, 'codex-cli 0.154.0')
  const result = { turn: { id: 'turn-1', items: [], status: 'completed' } }
  original.response('turn/start', result)
  const definitions = value.definitions as JsonObject
  const v2 = definitions.v2 as JsonObject
  const turn = v2.Turn as JsonObject
  const properties = turn.properties as JsonObject
  properties.status = { enum: ['interrupted'] }
  const replacement = protocolFromBundle(value, 'codex-cli 0.154.0')
  assert.throws(() => replacement.response('turn/start', result), /0\.154\.0/)
  assert.doesNotThrow(() => replacement.response('turn/start', { turn: { ...result.turn, status: 'interrupted' } }))
  assert.doesNotThrow(() => original.response('turn/start', result))
})

it('preserves the caller provider version when reusing validators for identical schema content', () => {
  protocolFromBundle(bundle(), 'codex-cli 0.154.0')
  const protocol = protocolFromBundle(bundle(), 'codex-cli 0.156.1')
  assert.throws(() => protocol.serverResponse('item/commandExecution/requestApproval', {
    decision: 'invented-allow',
  }), /0\.156\.1/)
})

it('rejects an unresolved referenced definition before execution', () => {
  const value = bundle()
  const definitions = value.definitions as JsonObject
  const v2 = definitions.v2 as JsonObject
  Reflect.deleteProperty(v2, 'Turn')
  assert.throws(() => protocolFromBundle(value))
})
