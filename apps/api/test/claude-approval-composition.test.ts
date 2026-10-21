import { describe, expect, it, vi } from 'vitest'
import { once } from 'node:events'
import { Socket } from 'node:net'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { Client as FileClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { fileToolFixture } from './support/fileTools.js'
import { productionClaudeFixture, managementEndpoint } from './support/claudeProduction.js'
import { PostgresClaudeInteractionAuthority } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'

async function offeredTool(f: ReturnType<typeof productionClaudeFixture>, name: string, input: Record<string, unknown>,
  provenance: { name: string; source: string }) {
  const session = { harness: 'claude' as const, nativeSessionId: 'recorded-session', providerVersion: '2.1.284' }
  const observed: string[] = []
  const output = (async () => {
    for await (const event of f.manager.startInitialTurn(f.start, {
      prompt: 'Call the admitted tool', clientCorrelationId: f.start.correlationId!,
      onSessionObserved: async observed => { f.row.native_session_id = observed.nativeSessionId; f.row.provider_version = observed.providerVersion },
      onMessageSubmitted: async submission => { f.row.payload.nativeSubmission = submission },
    })) observed.push(event.type)
  })()
  const message = (await (await f.ready.promise).next()).value!
  await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, claude_code_version: session.providerVersion, cwd: '/recorded/work' })
  await f.frames.offer({ type: 'assistant', uuid: 'tool-reply', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
    parent_tool_use_id: null, message: { id: 'tool-api-message', content: [{ type: 'tool_use', id: 'observed-tool', name, input }] } })
  await vi.waitFor(() => expect(f.manager.nativeCallbackContext(session.nativeSessionId, 'observed-tool')).toBeDefined())
  const options = f.sdkQuery.mock.calls[0]![0].options as Options
  const controller = new AbortController()
  const hookInput = { session_id: session.nativeSessionId, transcript_path: '/recorded/transcript', cwd: '/recorded/work',
    tool_use_id: 'observed-tool', tool_name: name, tool_input: input, mcp_server: provenance }
  const before = options.hooks!.PreToolUse![0]!.hooks[0]!
  const policy = await before({ ...hookInput, hook_event_name: 'PreToolUse' }, 'observed-tool', { signal: controller.signal })
  const permission = () => options.canUseTool!(name, input, { toolUseID: 'observed-tool', requestId: 'observed-permission',
    signal: controller.signal, mcpServer: provenance })
  return { session, message, output, observed, options, controller, hookInput, policy, permission,
    finish: async () => {
      await f.frames.offer({ type: 'assistant', uuid: 'final-reply', session_id: session.nativeSessionId,
        user_message_uuid: message.uuid, parent_tool_use_id: null,
        message: { id: 'final-api-message', content: [{ type: 'text', text: 'DONE' }] } })
      await f.frames.offer({ type: 'result', uuid: 'tool-result', session_id: session.nativeSessionId,
        user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'DONE' })
      await output
    } }
}

async function approveTool(f: ReturnType<typeof productionClaudeFixture>, call: Awaited<ReturnType<typeof offeredTool>>) {
  const decision = call.permission()
  await vi.waitFor(async () => expect(await f.manager.pending(call.session)).toBeDefined())
  const pending = (await f.manager.pending(call.session))!
  f.claim(call.session, 'observed-permission', 'observed-tool')
  await f.manager.respond(call.session, 'observed-permission', pending.responseOptions[0]!)
  expect(await decision).toMatchObject({ behavior: 'allow' })
  return pending
}

describe('production Claude approval composition', () => {
  it('closes management connections that have not sent an HTTP request', async () => {
    const endpoint = await managementEndpoint()
    const socket = new Socket()
    try {
      const address = new URL(endpoint.url)
      const accepted = once(endpoint.app.server, 'connection')
      const connected = once(socket, 'connect')
      socket.connect({ host: address.hostname, port: Number(address.port) })
      await Promise.all([accepted, connected])
      socket.resume()

      // Attach before shutdown so an immediate socket close is also observed.
      const closed = once(socket, 'close')
      await endpoint.app.close()
      await closed
      expect(socket.destroyed).toBe(true)
      expect(endpoint.list).not.toHaveBeenCalled()
    } finally {
      socket.destroy()
      await endpoint.app.close()
    }
  })

  it('admits an authenticated management manifest through runner, manager, policy callbacks and a real MCP handler', async () => {
    const endpoint = await managementEndpoint()
    const f = productionClaudeFixture('operator', undefined, endpoint.url)
    const client = new Client({ name: 'management-call', version: '1' })
    try {
      const start = { ...f.start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'synthetic-scoped-token' } } }
      await f.manager.inspectMcp()
      await f.manager.refreshInspectionCredentials(start, { graphql: { type: 'http', url: endpoint.url,
        headers: { Authorization: 'Bearer synthetic-scoped-token' } } })
      f.start.environment = start.environment
      const call = await offeredTool(f, 'mcp__graphql__workspace_list', {}, { name: 'graphql', source: 'dynamic' })
      expect(call.policy).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
      const pending = await approveTool(f, call)
      expect((await f.manager.reconcileResponse!(call.session, { nativeRequestId: 'observed-permission',
        nativeRequestType: pending.nativeRequestType, option: pending.responseOptions[0]! })).responseDeliveries).toEqual([])
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
        authProvider: { token: async () => 'synthetic-scoped-token' },
      }))
      const result = await client.callTool({ name: 'workspace_list', arguments: { detail: 'full' } })
      expect(result.isError).not.toBe(true)
      expect(endpoint.list).toHaveBeenCalledOnce()
      await call.options.hooks!.PostToolUse![0]!.hooks[0]!({ ...call.hookInput, hook_event_name: 'PostToolUse',
        tool_response: result }, 'observed-tool', { signal: call.controller.signal })
      const history = await f.manager.reconcile(call.session, f.start.correlationId!)
      expect(history.responseDeliveries).toMatchObject([{ optionId: 'allow_once', nativeIdentity: {
        kind: 'message', nativeMessageId: call.message.uuid,
      } }])
      await call.finish()
    } finally { await client.close(); await f.manager.dispose?.(); await endpoint.app.close() }
  })

  it.each(['foreign-server', 'user', 'missing-tool'])('rejects %s despite a matching management tool name', async variant => {
    const endpoint = await managementEndpoint()
    const f = productionClaudeFixture('operator', undefined, endpoint.url)
    try {
      f.start.environment = { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'synthetic-scoped-token' } }
      await f.manager.inspectMcp()
      await f.manager.refreshInspectionCredentials(f.start, { graphql: { type: 'http', url: endpoint.url,
        headers: { Authorization: 'Bearer synthetic-scoped-token' } } })
      const provenance = { name: variant === 'foreign-server' ? 'foreign' : 'graphql', source: variant === 'user' ? 'user' : 'dynamic' }
      const name = variant === 'missing-tool' ? 'mcp__graphql__workspace_update' : 'mcp__graphql__workspace_list'
      const call = await offeredTool(f, name, {}, provenance)
      expect(call.policy).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      expect(await call.permission()).toMatchObject({ behavior: 'deny' })
      expect(await f.manager.pending(call.session)).toBeUndefined()
      expect(endpoint.list).not.toHaveBeenCalled()
      await call.finish()
    } finally { await f.manager.dispose?.(); await endpoint.app.close() }
  })

  it('keeps an allow-once selection uncertain when the SDK aborts before callback completion', async () => {
    const stage = (name: string) => console.info(`Recorded approval abort: ${name}`)
    const endpoint = await managementEndpoint()
    const f = productionClaudeFixture('operator', undefined, endpoint.url)
    const validateResponse = PostgresClaudeInteractionAuthority.prototype.validateResponse
    const validation = vi.spyOn(PostgresClaudeInteractionAuthority.prototype, 'validateResponse')
    try {
      f.start.environment = { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'synthetic-scoped-token' } }
      await f.manager.inspectMcp()
      stage('inspection complete')
      await f.manager.refreshInspectionCredentials(f.start, { graphql: { type: 'http', url: endpoint.url,
        headers: { Authorization: 'Bearer synthetic-scoped-token' } } })
      stage('credential refresh complete')
      const call = await offeredTool(f, 'mcp__graphql__workspace_list', {}, { name: 'graphql', source: 'dynamic' })
      stage('tool observed')
      const decision = call.permission()
      await vi.waitFor(async () => expect(await f.manager.pending(call.session)).toBeDefined())
      const pending = (await f.manager.pending(call.session))!
      stage('approval pending')
      f.claim(call.session, 'observed-permission', 'observed-tool')
      let validations = 0
      validation.mockImplementation(async function (this: PostgresClaudeInteractionAuthority, identity, answer) {
        await validateResponse.call(this, identity, answer)
        if (++validations === 2) {
          call.controller.abort(new Error('SDK callback canceled after selection'))
        }
      })
      await expect(f.manager.respond(call.session, 'observed-permission', pending.responseOptions[0]!)).rejects.toThrow('canceled')
      stage('response uncertain')
      expect(await decision).toMatchObject({ behavior: 'deny', interrupt: true })
      stage('SDK callback completed')
      const observed = await f.manager.reconcileResponse!(call.session, { nativeRequestId: 'observed-permission',
        nativeRequestType: pending.nativeRequestType, option: pending.responseOptions[0]! })
      stage('response reconciled')
      expect(observed.responseDeliveries).toEqual([])
      expect(observed.interactionDeliveries).toMatchObject([{ state: 'uncertain' }])
      expect(endpoint.list).not.toHaveBeenCalled()
      const closed = expect(call.output).rejects.toThrow('submission remains uncertain')
      f.frames.close()
      await closed
      stage('SDK output closed')
    } finally {
      stage('disposing')
      validation.mockRestore()
      await f.manager.dispose?.()
      stage('native manager disposed')
      await endpoint.app.close()
      stage('cleanup complete')
    }
  })

  it('admits a real local file MCP call and revokes its credential before the same request finishes', async () => {
    const files = await fileToolFixture()
    files.principal.id = 'sender'
    files.scope.chat = { kind: 'agent', conversationId: 'agent', workspaceId: 'workspace', workflowId: 'workflow', agentId: 'agent' }
    files.scopes.set('agent', files.scope)
    const ref = await files.upload('file-through-production')
    const f = productionClaudeFixture('agent', undefined, undefined, files.service)
    const client = new FileClient({ name: 'production-file-call', version: '1' })
    const issue = vi.spyOn(files.sessions, 'issueForAcceptedSession')
    try {
      const call = await offeredTool(f, 'mcp__graphql-files__files.read', ref, { name: 'graphql-files', source: 'sdk' })
      expect(call.policy).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } })
      await approveTool(f, call)
      const server = call.options.mcpServers!['graphql-files']
      if (server?.type !== 'sdk') throw new Error('Production did not install the local file server.')
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      const result = await client.callTool({ name: 'files.read', arguments: ref, _meta: { 'claudecode/toolUseId': 'observed-tool' } })
      expect(result.isError).not.toBe(true)
      expect(result.structuredContent).toMatchObject({ contentBase64: Buffer.from('file-through-production').toString('base64') })
      expect(issue).toHaveBeenCalledOnce()
      const token = await issue.mock.results[0]!.value
      await expect(files.sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
      await call.options.hooks!.PostToolUse![0]!.hooks[0]!({ ...call.hookInput, hook_event_name: 'PostToolUse',
        tool_response: result }, 'observed-tool', { signal: call.controller.signal })
      expect((await f.manager.reconcile(call.session, f.start.correlationId!)).responseDeliveries).toHaveLength(1)
      await call.finish()
    } finally { await client.close(); await f.manager.dispose?.() }
  })

  it('keeps file-only owners unable to call management or foreign file servers', async () => {
    const f = productionClaudeFixture('agent')
    try {
      const call = await offeredTool(f, 'mcp__graphql__workspace_list', {}, { name: 'graphql', source: 'dynamic' })
      expect(call.policy).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
      expect(await call.permission()).toMatchObject({ behavior: 'deny' })
      expect(await f.manager.pending(call.session)).toBeUndefined()
      await call.finish()
    } finally { await f.manager.dispose?.() }
  })

})
