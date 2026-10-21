import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { query, type Options, type SDKUserMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ClaudeSdkClient } from '../../src/modules/harnesses/claudeSdk/port.js'

interface ToolCall { name: string; arguments: Record<string, unknown>; server: string; source: 'sdk' | 'dynamic' }
interface Wire {
  type?: string
  request_id?: string
  subtype?: string
  error?: unknown
  behavior?: string
  request?: Wire
  response?: Wire
  hooks?: Record<string, { hookCallbackIds: string[] }[]>
  servers?: Record<string, { type: string; url?: string; headers?: Record<string, string> }>
  hookSpecificOutput?: { permissionDecision?: string }
  mcp_response?: { error?: unknown; result?: unknown }
}

/** Recorded CLI wire traffic only. The official SDK owns hook dispatch, permission
 * responses, in-process MCP transport and server connection; HTTP calls use its delivered config. */
export function claudeSdkToolTransport(cwd: string, calls: (content: string) => ToolCall[],
  options: { beforePermission?(): Promise<void>; replyText?(): string } = {}) {
  const results: Array<{ name: string; result: unknown; allowed: boolean }> = []
  const offers: string[] = []
  const queries: Array<{ resume: unknown; closed: boolean }> = []
  const progress: Array<{ tool: string; stage: string }> = []
  const errors: string[] = []
  let failResume = false
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => { throw new Error('Tool composition must not fork.') },
    query(input) {
      if (input.options.resume && failResume) {
        failResume = false
        throw new Error('Recorded resume initialization failed')
      }
      const state = { resume: input.options.resume, closed: false }
      queries.push(state)
      const clients: Client[] = []
      const nativeId = typeof input.options.resume === 'string' ? input.options.resume : randomUUID()
      const stdout = new PassThrough()
      const stdin = new PassThrough()
      const emitter = new EventEmitter()
      const lines = createInterface({ input: stdin })
      const pending = new Map<string, { resolve(value: Wire): void; reject(error: Error): void }>()
      let hooks: NonNullable<Wire['hooks']> = {}
      let servers: NonNullable<Wire['servers']> = Object.fromEntries(Object.entries(input.options.mcpServers as Record<string, Record<string, unknown>> ?? {})
        .map(([name, config]) => [name, config.type === 'sdk' ? { type: 'sdk', name }
          : config as NonNullable<Wire['servers']>[string]]))
      const send = (value: unknown) => stdout.write(JSON.stringify(value) + '\n')
      const request = (body: Record<string, unknown>): Promise<Wire> => new Promise((resolve, reject) => {
        const id = randomUUID()
        pending.set(id, { resolve, reject })
        send({ type: 'control_request', request_id: id, request: body })
      })
      const hook = async (event: string, call: ToolCall, toolId: string, extra: Record<string, unknown> = {}) => {
        for (const matcher of hooks[event] ?? []) for (const callbackId of matcher.hookCallbackIds) {
          const answer = await request({ subtype: 'hook_callback', callback_id: callbackId, tool_use_id: toolId,
            input: { hook_event_name: event, session_id: nativeId, transcript_path: '/recorded/transcript', cwd,
              tool_use_id: toolId, tool_name: `mcp__${call.server}__${call.name}`, tool_input: call.arguments,
              mcp_server: { name: call.server, source: call.source }, ...extra } })
          if (answer.hookSpecificOutput?.permissionDecision === 'deny') return false
        }
        return true
      }
      const execute = async (message: SDKUserMessage) => {
        offers.push(message.uuid!)
        send({ type: 'system', subtype: 'init', session_id: nativeId, claude_code_version: '2.1.284', cwd })
        for (const call of calls(String(message.message.content))) {
          progress.push({ tool: call.name, stage: 'permission' })
          const toolId = randomUUID()
          send({ type: 'assistant', uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: null,
            user_message_uuid: message.uuid, message: { id: randomUUID(), role: 'assistant',
              content: [{ type: 'tool_use', id: toolId, name: `mcp__${call.server}__${call.name}`, input: call.arguments }] } })
          await options.beforePermission?.()
          let allowed = await hook('PreToolUse', call, toolId)
          if (allowed) {
            const decision = await request({ subtype: 'can_use_tool', tool_name: `mcp__${call.server}__${call.name}`,
              input: call.arguments, tool_use_id: toolId, mcp_server: { name: call.server, source: call.source } })
            allowed = decision.behavior === 'allow'
          }
          let result: unknown
          progress.push({ tool: call.name, stage: allowed ? 'allowed' : 'denied' })
          if (allowed && call.source === 'sdk') {
            const response = await request({ subtype: 'mcp_message', server_name: call.server,
              message: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: {
                name: call.name, arguments: call.arguments, _meta: { 'claudecode/toolUseId': toolId },
              } } })
            if (!response.mcp_response) throw new Error('The SDK MCP response is missing.')
            if (response.mcp_response.error) throw new Error(JSON.stringify(response.mcp_response.error))
            result = response.mcp_response.result
          } else if (allowed) {
            const config = servers[call.server]
            if (!config?.url) throw new Error('The delivered HTTP MCP configuration is missing.')
            const client = new Client({ name: 'claude-native-tool', version: '1' })
            clients.push(client)
            progress.push({ tool: call.name, stage: 'http-connect' })
            await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { ...(config.headers ? { headers: config.headers } : {}) } }))
            progress.push({ tool: call.name, stage: 'http-call' })
            result = await client.callTool({ name: call.name, arguments: call.arguments })
          }
          results.push({ name: call.name, result, allowed })
          progress.push({ tool: call.name, stage: 'result' })
          await hook(allowed ? 'PostToolUse' : 'PermissionDenied', call, toolId,
            allowed ? { tool_response: result } : { reason: 'The accepted policy denied this tool.' })
          progress.push({ tool: call.name, stage: 'acknowledged' })
          send({ type: 'user', uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId,
              is_error: !allowed, content: allowed ? JSON.stringify(result) : 'Permission denied' }] } })
        }
        const replyText = options.replyText?.() ?? 'SDK tools finished'
        send({ type: 'assistant', uuid: randomUUID(), session_id: nativeId, parent_tool_use_id: null,
          user_message_uuid: message.uuid, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: replyText }] } })
        send({ type: 'result', uuid: randomUUID(), session_id: nativeId, user_message_uuid: message.uuid,
          subtype: 'success', is_error: false, result: replyText })
      }
      lines.on('line', line => {
        const frame = JSON.parse(line) as Wire
        if (frame.type === 'control_response') {
          const response = frame.response
          if (!response?.request_id) throw new Error('Recorded control response identity is missing.')
          const waiter = pending.get(response.request_id)
          pending.delete(response.request_id)
          if (response.subtype === 'error') waiter?.reject(new Error(String(response.error)))
          else waiter?.resolve(response.response ?? {})
        } else if (frame.type === 'control_request') {
          const body = frame.request
          if (!body) throw new Error('Recorded control request is missing.')
          let response: Record<string, unknown> = {}
          if (body.subtype === 'initialize') hooks = body.hooks ?? {}
          else if (body.subtype === 'mcp_set_servers') {
            servers = { ...servers, ...body.servers }
            response = { added: Object.keys(body.servers ?? {}), removed: [], errors: {} }
          } else if (body.subtype === 'mcp_status') response = { mcpServers: Object.entries(servers).map(([name, config]) => ({
            name, status: 'connected', config, tools: [],
          })) }
          send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response } })
        } else if (frame.type === 'user') void execute(frame as unknown as SDKUserMessage).catch(error => {
          errors.push(error instanceof Error ? error.message : String(error))
          if (!state.closed) emitter.emit('error', error)
        })
      })
      const nativeProcess: SpawnedProcess = Object.assign(emitter, { stdin, stdout, killed: false, exitCode: null,
        kill() {
          if (state.closed) return true
          state.closed = true
          for (const waiter of pending.values()) waiter.reject(new Error('Recorded CLI closed'))
          pending.clear()
          lines.close()
          stdin.end()
          stdout.end()
          emitter.emit('exit', 0, null)
          return true
        },
      })
      Object.defineProperties(nativeProcess, { killed: { get: () => state.closed }, exitCode: { get: () => state.closed ? 0 : null } })
      const running = query({ prompt: input.prompt as AsyncIterable<SDKUserMessage>, options: {
        ...input.options as Options, executable: 'node', pathToClaudeCodeExecutable: '/recorded/claude',
        spawnClaudeCodeProcess: () => nativeProcess,
      } })
      return {
        [Symbol.asyncIterator]: () => running[Symbol.asyncIterator](),
        initializationResult: () => running.initializationResult(), mcpServerStatus: () => running.mcpServerStatus(),
        setMcpServers: entries => running.setMcpServers(entries as Parameters<typeof running.setMcpServers>[0]),
        interrupt: () => running.interrupt(), close: () => running.close(),
        joinClosed: async () => { await Promise.all(clients.map(client => client.close())) },
      }
    },
  }
  return { sdk, results, offers, queries, progress, errors, failNextResume: () => { failResume = true } }
}
