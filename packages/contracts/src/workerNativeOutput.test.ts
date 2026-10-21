import { describe, expect, it } from 'vitest'
import { WorkerNativeOutputCommandSchema, WorkerNativeOutputBytesSchema, WORKER_NATIVE_OUTPUT_FILE_OPERATIONS,
  parseNativeOutputToolCommand, nativeOutputToolArguments, WORKER_NATIVE_OUTPUT_TOOL_NAMES } from './workerNativeOutput.js'
import { WorkerMcpRelayRequestSchema, WorkerNativeOutputAuthorizationSchema, WorkerNativeOutputDeclarationsAuthorizationSchema } from './workerMcpRelay.js'

describe('closed worker native output commands', () => {
  const create = { operation: 'create', commandId: 'create-command', filename: 'result.md', mediaType: 'text/markdown' }
  it('shares normalized path-free arguments between MCP calls and native command capture', () => {
    const commands = [create,
      { operation: 'append', commandId: 'append-command', artifactId: 'opaque-output', offset: 0, contentBase64: 'Zg==' },
      { operation: 'seal', commandId: 'seal-command', artifactId: 'opaque-output' },
      { operation: 'publish', publication: { commandId: 'publish-command', artifactId: 'opaque-output',
        filename: 'result.md', mediaType: 'text/markdown' } },
    ].map(command => WorkerNativeOutputCommandSchema.parse(command))
    for (const command of commands) {
      const name = WORKER_NATIVE_OUTPUT_TOOL_NAMES[command.operation]
      const input = nativeOutputToolArguments(command)
      expect(parseNativeOutputToolCommand(name, input)).toEqual(command)
      expect(() => parseNativeOutputToolCommand(name, { ...input, scope: 'foreign' })).toThrow()
      expect(() => parseNativeOutputToolCommand(name, { ...input, operation: command.operation })).toThrow()
    }
    expect(() => parseNativeOutputToolCommand('foreign-tool', {})).toThrow()
  })
  it('validates file metadata and prohibits caller-selected scope, path and identity', () => {
    expect(WorkerNativeOutputCommandSchema.parse(create)).toEqual(create)
    for (const key of ['path', 'scope', 'executionId', 'nativeSessionId', 'turnId', 'root']) {
      expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, [key]: '/foreign' }).success).toBe(false)
    }
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, filename: 'result.pdf' }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, filename: '../result.md' }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...create, commandId: 'short' }).success).toBe(false)
  })
  it('limits decoded append bytes and requires canonical base64 including zero padding bits', () => {
    expect(WorkerNativeOutputBytesSchema.parse(Buffer.alloc(65536).toString('base64'))).toBeTruthy()
    for (const value of [Buffer.alloc(65537).toString('base64'), 'Zh==', 'Zm9=', 'Zg', 'Zg==\n', '_w==']) {
      expect(WorkerNativeOutputBytesSchema.safeParse(value).success).toBe(false)
    }
    const append = { operation: 'append', commandId: 'append-command', artifactId: 'handle', offset: 0, contentBase64: 'Zg==' }
    expect(WorkerNativeOutputCommandSchema.parse(append)).toEqual(append)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...append, offset: -1 }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...append, offset: 0.5 }).success).toBe(false)
  })
  it('publishes only a host handle with display metadata; scope comes from admitted host context', () => {
    const publication = { commandId: create.commandId, filename: create.filename, mediaType: create.mediaType, artifactId: 'host-handle' }
    const command = { operation: 'publish', publication }
    expect(WorkerNativeOutputCommandSchema.parse(command)).toEqual(command)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...command, publication: { ...publication, scope: { kind: 'temporary' } } }).success).toBe(false)
    expect(WorkerNativeOutputCommandSchema.safeParse({ ...publication, operation: 'publish' }).success).toBe(false)
  })
  it('requires original Main scope on mutation responses and keeps declarations free of fabricated native facts', () => {
    const base = { version: 1, mainId: '00000000-0000-4000-8000-000000000001', audience: 'worker', principalId: 'principal',
      executionId: 'execution', agentId: 'agent', operationId: 'operation', attemptId: 'attempt', bindingHash: 'a'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z' }
    const native = { ...base, outputOperation: 'create', nativeSessionId: 'native', turnId: 'turn' }
    expect(WorkerNativeOutputAuthorizationSchema.safeParse(native).success).toBe(false)
    const scope = { kind: 'temporary', chat: { kind: 'agent', conversationId: 'conversation', workspaceId: 'workspace',
      workflowId: 'workflow', agentId: 'agent', runId: 'run', executionId: 'execution' } }
    expect(WorkerNativeOutputAuthorizationSchema.parse({ ...native, scope }).scope).toEqual(scope)
    expect(WorkerNativeOutputAuthorizationSchema.safeParse({ ...native, scope: { ...scope, chat: { ...scope.chat, executionId: 'foreign' } } }).success).toBe(false)
    const declarations = { ...base, agentConfigurationVersionId: 'configuration', outputOperations: ['create', 'append', 'seal', 'publish'] }
    expect(WorkerNativeOutputDeclarationsAuthorizationSchema.parse(declarations)).toEqual(declarations)
    for (const key of ['scope', 'nativeSessionId', 'turnId', 'qualified']) {
      expect(WorkerNativeOutputDeclarationsAuthorizationSchema.safeParse({ ...declarations, [key]: 'fabricated' }).success).toBe(false)
    }
    expect(WorkerNativeOutputDeclarationsAuthorizationSchema.safeParse({ ...declarations, outputOperations: ['create', 'create', 'seal', 'publish'] }).success).toBe(false)
  })
  it('maps mutation and publication to existing file permissions without expanding relay lease authorization', () => {
    expect(WORKER_NATIVE_OUTPUT_FILE_OPERATIONS).toEqual({ create: 'files.write_working_copy', append: 'files.write_working_copy', seal: 'files.write_working_copy', publish: 'files.publish_result' })
    expect(WorkerMcpRelayRequestSchema.options.map(schema => schema.shape.operation.value)).toContain('worker-mcp.authorize-native-output')
  })
})
