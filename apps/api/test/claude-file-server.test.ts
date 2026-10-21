import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeFileMcpServer } from '../src/modules/files/claude/server.js'
import { createClaudeFileCallResolver } from '../src/modules/files/claude/callResolver.js'
import type { ClaudeNativeCallbackContext, ClaudeCallbackAuthority } from '../src/modules/harnesses/claudeSdk/callbackAvailability.js'
import type { ClaudeCallbackIdentity } from '../src/modules/harnesses/claudeSdk/interactions.js'
import { fileToolFixture } from './support/fileTools.js'

async function fixture(allowMutation = true, nativeResolver = false) {
  const f = await fileToolFixture()
  const identity: ClaudeCallbackIdentity = { ownerPrincipalId: f.context.ownerPrincipalId,
    nativeSessionId: f.context.nativeSessionId, nativeMessageId: 'observed-message', clientCorrelationId: 'correlation',
    attemptId: 'attempt', generation: 'generation', toolUseId: 'tool-use' }
  const context = { ...f.context, turnId: undefined, nativeMessageId: identity.nativeMessageId, allowMutation }
  const resolve = vi.fn(async (): Promise<ClaudeCallbackIdentity | undefined> => identity)
  const nativeContext: ClaudeNativeCallbackContext = { nativeSessionId: identity.nativeSessionId,
    nativeMessageId: identity.nativeMessageId!, clientCorrelationId: identity.clientCorrelationId!, generation: identity.generation! }
  const wait = vi.fn(async (toolUseId: string) => {
    if (toolUseId !== identity.toolUseId) throw new Error('No unique acknowledged root owner.')
    return nativeContext
  })
  const current = vi.fn((): ClaudeNativeCallbackContext | undefined => nativeContext)
  const authority = vi.fn((): ClaudeCallbackAuthority | undefined => ({ ownerPrincipalId: identity.ownerPrincipalId, attemptId: identity.attemptId }))
  const manager = { waitNativeCallbackContext: wait, nativeCallbackContext: current, callbackAuthority: authority }
  const lifetime = new AbortController()
  const calls = nativeResolver ? createClaudeFileCallResolver({ manager: () => manager, signal: lifetime.signal }) : { resolve }
  const admission = { current: vi.fn(async () => ({ context, expiresAt: new Date(f.clock().getTime() + 60_000) })) }
  const issue = vi.spyOn(f.sessions, 'issueForAcceptedSession')
  const adapter = createClaudeFileMcpServer({ sdk: { createSdkMcpServer, tool }, service: f.service,
    admission, calls, allowMutation })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'claude-file-fixture', version: '1.0.0' })
  await adapter.server.instance.connect(serverTransport)
  await client.connect(clientTransport)
  return { ...f, identity, context, resolve, admission, issue, adapter, client, wait, current, authority, lifetime,
    close: async () => { await adapter.close(); await client.close() } }
}

describe('official Claude SDK admitted file MCP server', () => {
  it('reads decoded UTF-8 Markdown while preserving split-character bytes', async () => {
    const f = await fixture()
    try {
      const text = '# 界\n'
      const ref = await f.upload(text)
      const result = await f.client.callTool({ name: 'files.read', arguments: ref })
      expect(result.isError).not.toBe(true)
      expect(result.content).toContainEqual({ type: 'text', text })
      expect(result.structuredContent).toMatchObject({ contentBase64: Buffer.from(text).toString('base64') })
      const split = await f.client.callTool({ name: 'files.read', arguments: { ...ref, offset: 2, length: 1 } })
      expect(split.isError).not.toBe(true)
      expect(split.structuredContent).toMatchObject({
        byteLength: 1, contentBase64: Buffer.from('界').subarray(0, 1).toString('base64'),
      })
      expect(split.content).not.toContainEqual({ type: 'text', text: '�' })
    } finally { await f.close() }
  })

  it('uses the actual SDK transport and shared service; discovery creates no credential', async () => {
    const f = await fixture()
    try {
      expect(f.adapter.server.type).toBe('sdk')
      expect((await f.client.listTools()).tools.map(value => value.name)).toHaveLength(6)
      expect(f.issue).not.toHaveBeenCalled()
      const ref = await f.upload('native-file-bytes')
      const result = await f.client.callTool({ name: 'files.read', arguments: { ...ref, offset: 0, length: 6 } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ status: 'ready', contentBase64: Buffer.from('native').toString('base64') })
      expect(result.content).toContainEqual({ type: 'text', text: 'native' })
      expect(f.issue).toHaveBeenCalledOnce()
      const issued = await f.issue.mock.results[0]!.value
      await expect(f.sessions.authenticate(issued)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
      expect(f.tools.reads).toMatchObject([{ runId: 'run-a', executionId: 'execution-a', ...ref }])
      f.revoke()
      expect((await f.client.callTool({ name: 'files.read', arguments: ref })).isError).toBe(true)
    } finally { await f.close() }
  })

  it('retires each completed call credential while later calls in the same request remain authorized', async () => {
    const f = await fixture()
    try {
      for (let index = 0; index < 16; index += 1) {
        const result = await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 } })
        expect(result.isError).not.toBe(true)
        const issued = await f.issue.mock.results[index]!.value
        await expect(f.sessions.authenticate(issued)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
      }
      expect(f.issue).toHaveBeenCalledTimes(16)
    } finally { await f.close() }
  })

  it('rejects missing native ACK evidence and child callbacks before credential issuance', async () => {
    const f = await fixture()
    try {
      f.resolve.mockResolvedValueOnce(undefined)
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 } })).isError).toBe(true)
      f.resolve.mockResolvedValueOnce({ ...f.identity, agentId: 'child' })
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 } })).isError).toBe(true)
      f.resolve.mockResolvedValueOnce({ ...f.identity, nativeMessageId: 'planned-uuid' })
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 } })).isError).toBe(true)
      expect(f.issue).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('advertises only reads for a read-only harness and preserves conversation scope', async () => {
    const f = await fixture(false)
    try {
      expect((await f.client.listTools()).tools.map(value => value.name)).toEqual(['files.list', 'files.read'])
      expect((await f.client.callTool({ name: 'files.create_working_copy', arguments: {} })).isError).toBe(true)
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.foreign, limit: 25 } })).isError).toBe(true)
    } finally { await f.close() }
  })

  it('rechecks live caller write authority through the existing service', async () => {
    const f = await fixture(), source = await f.upload()
    try {
      f.denyWrites()
      const result = await f.client.callTool({ name: 'files.create_working_copy',
        arguments: { commandId: randomUUID(), source, destination: f.scope } })
      expect(result.isError).toBe(true)
      expect(f.tools.artifacts.size).toBe(0)
    } finally { await f.close() }
  })

  it('creates and publishes through existing artifact ownership, then revokes its private credential', async () => {
    const f = await fixture(), source = await f.upload('original')
    try {
      const copied = await f.client.callTool({ name: 'files.create_working_copy',
        arguments: { commandId: randomUUID(), source, destination: f.scope } })
      expect(copied.isError).not.toBe(true)
      const value = copied.structuredContent as { value: { artifactId: string } }
      const published = await f.client.callTool({ name: 'files.publish_result', arguments: {
        commandId: randomUUID(), artifactId: value.value.artifactId, scope: f.scope, filename: 'result.md', mediaType: 'text/markdown',
      } })
      expect(published.isError).not.toBe(true)
      expect(f.repository.values.size).toBe(2)
      const token = await f.issue.mock.results[0]!.value
      await f.adapter.close()
      await expect(f.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
    } finally { await f.close() }
  })

  it('propagates actual MCP metadata and joins only its provider tool-use ID to captured authority', async () => {
    const f = await fixture(true, true)
    try {
      const source = await f.upload('metadata-bound')
      const result = await f.client.callTool({ name: 'files.read', arguments: { ...source, offset: 0, length: 64 },
        _meta: { 'claudecode/toolUseId': f.identity.toolUseId } })
      expect(result.isError).not.toBe(true)
      expect(f.wait).toHaveBeenCalledWith(f.identity.toolUseId, expect.any(AbortSignal))
      expect(f.admission.current).toHaveBeenCalledWith(f.identity)
      expect(f.issue).toHaveBeenCalledOnce()
      expect((await f.client.callTool({ name: 'files.read', arguments: source,
        _meta: { 'claudecode/toolUseId': f.identity.toolUseId } })).isError).not.toBe(true)
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope },
        _meta: { 'claudecode/toolUseId': f.identity.toolUseId } })).isError).not.toBe(true)
    } finally { await f.close() }
  })

  it('denies absent, foreign, child and ambiguous tool IDs without an issued file credential', async () => {
    const f = await fixture(true, true)
    try {
      expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 } })).isError).toBe(true)
      expect(f.wait).not.toHaveBeenCalled()
      for (const toolUseId of ['foreign', 'child', 'ambiguous', 'missing-ack']) {
        expect((await f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 },
          _meta: { 'claudecode/toolUseId': toolUseId } })).isError).toBe(true)
      }
      expect(f.issue).not.toHaveBeenCalled()
    } finally { await f.close() }
  })

  it('rechecks generation and captured authority after waiting and denies ended lifetimes', async () => {
    const f = await fixture(true, true)
    const call = () => f.client.callTool({ name: 'files.list', arguments: { scope: f.scope, limit: 25 },
      _meta: { 'claudecode/toolUseId': f.identity.toolUseId } })
    try {
      f.current.mockReturnValueOnce({ nativeSessionId: f.identity.nativeSessionId, nativeMessageId: f.identity.nativeMessageId!,
        clientCorrelationId: f.identity.clientCorrelationId!, generation: 'stale' })
      expect((await call()).isError).toBe(true)
      f.current.mockReturnValueOnce(undefined)
      expect((await call()).isError).toBe(true)
      f.authority.mockReturnValueOnce(undefined)
      expect((await call()).isError).toBe(true)
      f.lifetime.abort()
      expect((await call()).isError).toBe(true)
      expect(f.issue).not.toHaveBeenCalled()
    } finally { await f.close() }
  })
})
