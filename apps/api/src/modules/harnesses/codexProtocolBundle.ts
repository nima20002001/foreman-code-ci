import { createHash } from 'node:crypto'

import { z } from 'zod'

import { HarnessExecutionError } from './errors.js'
import { isObject, object, type CodexProtocol, type JsonObject, type RpcRequest } from './codexStdioTransport.js'
import type { CodexMethodMap } from './codexMethodTypes.js'

const responseTypes: Record<Exclude<keyof CodexMethodMap, 'config/mcpServer/reload'>, string> = {
  initialize: 'InitializeResponse',
  'thread/start': 'ThreadStartResponse', 'thread/resume': 'ThreadResumeResponse', 'thread/read': 'ThreadReadResponse',
  'thread/turns/list': 'ThreadTurnsListResponse', 'thread/items/list': 'ThreadItemsListResponse',
  'turn/start': 'TurnStartResponse', 'turn/interrupt': 'TurnInterruptResponse',
  'turn/steer': 'TurnSteerResponse', 'thread/fork': 'ThreadForkResponse',
  'config/read': 'ConfigReadResponse', 'model/list': 'ModelListResponse',
  'config/batchWrite': 'ConfigWriteResponse',
  'mcpServerStatus/list': 'ListMcpServerStatusResponse',
  'account/login/start': 'LoginAccountResponse', 'account/login/cancel': 'CancelLoginAccountResponse',
}
const inspectionResponseTypes = { 'account/read': 'GetAccountResponse' } as const

const threadResponseFields = {
  thread: 'object', model: 'string', modelProvider: 'string', cwd: 'string', sandbox: 'object',
  approvalPolicy: 'policy', approvalsReviewer: 'string', reasoningEffort: 'string', serviceTier: 'string',
} as const
export const CODEX_RESPONSE_FIELDS: Record<string, Record<string, string>> = {
  InitializeResponse: { userAgent: 'string' },
  ThreadStartResponse: threadResponseFields,
  ThreadResumeResponse: threadResponseFields,
  ThreadForkResponse: threadResponseFields,
  ThreadReadResponse: { thread: 'object' },
  ThreadTurnsListResponse: { data: 'array', nextCursor: 'string' },
  ThreadItemsListResponse: { data: 'array', nextCursor: 'string' },
  ModelListResponse: { data: 'array', nextCursor: 'string' },
  ListMcpServerStatusResponse: { data: 'array', nextCursor: 'string' },
  ConfigReadResponse: { config: 'object' },
  ConfigWriteResponse: { status: 'string', version: 'string' },
  TurnStartResponse: { turn: 'object' },
  TurnSteerResponse: { turnId: 'string' },
  CancelLoginAccountResponse: { status: 'string' },
}

function checkResponseFields(type: string, value: unknown, providerVersion: string): void {
  const fields = CODEX_RESPONSE_FIELDS[type]
  if (!fields) return
  const response = isObject(value) ? value : {}
  for (const [name, expected] of Object.entries(fields)) {
    const observed = response[name]
    if (name === 'nextCursor' && observed === undefined) continue
    if (observed === null && ['reasoningEffort', 'serviceTier', 'nextCursor'].includes(name)) continue
    let valid: boolean
    switch (expected) {
      case 'array':
        valid = Array.isArray(observed)
        break
      case 'object':
        valid = isObject(observed)
        break
      case 'policy':
        valid = typeof observed === 'string' || isObject(observed)
        break
      default:
        valid = typeof observed === expected
    }
    if (!valid) throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
      `Codex ${providerVersion} does not satisfy the ${type}.${name} response contract.`)
  }
  if (isObject(response.thread) && (typeof response.thread.id !== 'string' || !Array.isArray(response.thread.turns))) {
    throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED',
      `Codex ${providerVersion} does not satisfy the ${type}.thread identity/history response contract.`)
  }
}

const serverResponseTypes: Record<string, string> = {
  'item/commandExecution/requestApproval': 'CommandExecutionRequestApprovalResponse',
  'item/fileChange/requestApproval': 'FileChangeRequestApprovalResponse',
  'item/permissions/requestApproval': 'PermissionsRequestApprovalResponse',
  'item/tool/requestUserInput': 'ToolRequestUserInputResponse',
  'mcpServer/elicitation/request': 'McpServerElicitationRequestResponse',
}

const compiledSchemas = new Map<string, z.ZodType>()

function referencedDefinitions(schema: JsonObject, definitions: JsonObject): JsonObject {
  const selected: JsonObject = {}
  const pending: unknown[] = [schema]
  const visited = new Set<object>()
  while (pending.length) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    if (Array.isArray(value)) {
      pending.push(...value)
      continue
    }
    const entry = value as JsonObject
    if (typeof entry.$ref === 'string' && entry.$ref.startsWith('#/definitions/')) {
      const name = entry.$ref.slice('#/definitions/'.length).replace(/~1/g, '/').replace(/~0/g, '~')
      if (!Object.hasOwn(selected, name) && Object.hasOwn(definitions, name)) {
        Object.defineProperty(selected, name, { value: definitions[name], enumerable: true })
        pending.push(definitions[name])
      }
    }
    pending.push(...Object.values(entry))
  }
  return selected
}

/** Validation consumes the installation's generated schemas, not loose object casts. */
export function protocolFromBundle(bundle: JsonObject, providerVersion = 'unknown version'): CodexProtocol {
  const definitions = object(bundle.definitions, 'CODEX_SCHEMA_INVALID')
  const schemaDialect = 'http://json-schema.org/draft-07/schema#' as const
  if (bundle.$schema !== undefined && bundle.$schema !== schemaDialect) {
    throw new HarnessExecutionError('CODEX_SCHEMA_INVALID', 'The qualified schema bundle uses an unsupported JSON Schema dialect.')
  }
  const encodePointerSegment = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')
  const rewriteRefs = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteRefs)
    if (!isObject(value)) return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === '$ref' && typeof entry === 'string' && entry.startsWith('#/definitions/v2/')) {
        return [key, `#/definitions/${encodePointerSegment(`v2/${entry.slice('#/definitions/v2/'.length)}`)}`]
      }
      return [key, rewriteRefs(entry)]
    }))
  }
  const flattenedDefinitions: JsonObject = {}
  for (const [name, schema] of Object.entries(definitions)) {
    if (name === 'v2' && isObject(schema)) {
      for (const [v2Name, v2Schema] of Object.entries(schema)) {
        flattenedDefinitions[`v2/${v2Name}`] = rewriteRefs(v2Schema)
      }
    } else flattenedDefinitions[name] = rewriteRefs(schema)
  }
  const compiled = new Map<string, z.ZodType>()
  const definition = (name: string): JsonObject => {
    const v2 = isObject(definitions.v2) ? definitions.v2 : {}
    const value = v2[name] ?? definitions[name]
    if (!isObject(value)) throw new HarnessExecutionError('CODEX_SCHEMA_MISSING', `Missing schema ${name}.`)
    return value
  }
  const compile = (key: string, schema: JsonObject): z.ZodType => {
    const existing = compiled.get(key)
    if (existing) return existing
    // fromJSONSchema is already provided by the repository's pinned Zod version.
    // Zod resolves a single JSON Pointer segment after `definitions`; Codex's
    // generated bundle nests v2 schemas one level deeper. Flatten that namespace
    // without weakening the generated schema or changing its meaning.
    const rewritten = rewriteRefs(schema) as JsonObject
    // Zod JSON-round-trips each input; unrelated definitions multiply startup work for every RPC validator.
    const document = { ...rewritten, $schema: schemaDialect,
      definitions: referencedDefinitions(rewritten, flattenedDefinitions) }
    const identity = createHash('sha256').update(JSON.stringify(document)).digest('hex')
    let value = compiledSchemas.get(identity)
    if (!value) {
      value = z.fromJSONSchema(document)
      if (compiledSchemas.size >= 256) compiledSchemas.delete(compiledSchemas.keys().next().value!)
      compiledSchemas.set(identity, value)
    }
    compiled.set(key, value)
    return value
  }
  const check = (key: string, schema: JsonObject, value: unknown): void => {
    if (!compile(key, schema).safeParse(value).success) {
      throw new HarnessExecutionError('CODEX_CONTRACT_UNSUPPORTED', `Codex ${providerVersion} does not satisfy the ${key} schema contract.`)
    }
  }
  const branch = (name: string, method: string): JsonObject => {
    const schema = definition(name)
    const choices = schema.oneOf ?? schema.anyOf
    if (!Array.isArray(choices)) throw new HarnessExecutionError('CODEX_SCHEMA_INVALID', 'The qualified RPC union is missing.')
    const match = choices.find((choice) => {
      if (!isObject(choice) || !isObject(choice.properties) || !isObject(choice.properties.method)) return false
      const methodSchema = choice.properties.method
      return methodSchema.const === method || (Array.isArray(methodSchema.enum) && methodSchema.enum.includes(method))
    })
    if (!isObject(match)) throw new HarnessExecutionError('CODEX_METHOD_UNQUALIFIED', `Missing ${name} method ${method}.`)
    return match
  }
  // Check required schemas eagerly, before a provider process can execute a turn.
  for (const [method, type] of Object.entries(responseTypes)) {
    compile(`ClientRequest:${method}`, branch('ClientRequest', method))
    compile(type, definition(type))
  }
  for (const [method, type] of Object.entries(serverResponseTypes)) {
    compile(`ServerRequest:${method}`, branch('ServerRequest', method))
    compile(type, definition(type))
  }
  // Older schema fixtures and native releases without dynamic tools keep their
  // existing protocol. A bundle that advertises the response must also carry
  // the matching request branch before file calls can be accepted.
  // Real Codex bundles keep this type at the top level even when a v2 namespace exists.
  const dynamicToolResponse = (isObject(definitions.v2) ? definitions.v2.DynamicToolCallResponse : undefined) ?? definitions.DynamicToolCallResponse
  if (dynamicToolResponse) {
    compile('ServerRequest:item/tool/call', branch('ServerRequest', 'item/tool/call'))
    compile('DynamicToolCallResponse', definition('DynamicToolCallResponse'))
  }
  for (const method of ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved']) {
    compile(`ServerNotification:${method}`, branch('ServerNotification', method))
  }
  return {
    providerVersion,
    request: (message: RpcRequest) => check(`ClientRequest:${message.method}`, branch('ClientRequest', message.method), message),
    serverRequest: (message: RpcRequest) => check(`ServerRequest:${message.method}`, branch('ServerRequest', message.method), message),
    notification: (message: JsonObject) => {
      if (typeof message.method !== 'string') throw new Error('Native method missing.')
      check(`ServerNotification:${message.method}`, branch('ServerNotification', message.method), message)
    },
    response: (method, value) => {
      if (method === 'config/mcpServer/reload' || method === 'thread/compact/start') {
        // This method's response is the native empty object, with no params type.
        if (!isObject(value) || Object.keys(value).length !== 0) throw new Error('Invalid reload response.')
        return
      }
      const type = Object.hasOwn(responseTypes, method) ? responseTypes[method as keyof typeof responseTypes]
        : inspectionResponseTypes[method as keyof typeof inspectionResponseTypes]
      if (!type) throw new Error('Unqualified response method.')
      check(type, definition(type), value)
      checkResponseFields(type, value, providerVersion)
    },
    serverResponse: (method, value) => {
      const type = method === 'item/tool/call' && dynamicToolResponse ? 'DynamicToolCallResponse' : serverResponseTypes[method]
      if (!type) throw new Error('Unqualified native response.')
      check(type, definition(type), value)
    },
  }
}
