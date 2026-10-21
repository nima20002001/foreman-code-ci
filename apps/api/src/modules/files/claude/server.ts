import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AgentFileReadResultSchema } from '@foreman-code/contracts/files'
import { toolFailure, toolResult } from '../../../mcp/shared/results.js'
import { DomainError } from '../../errors.js'
import { ClaudeFileBridge, type ClaudeFileAdmission } from '../../harnesses/claudeSdk/files.js'
import type { ClaudeCallbackIdentity } from '../../harnesses/claudeSdk/interactions.js'
import type { AgentFileToolService } from '../tools/service.js'
import { isMutation } from '../tools/context.js'
import type { FileToolOperation } from '../tools/types.js'
import { markdownReadText } from '../tools/markdownReadText.js'
import type { ClaudeMcpToolManifest } from '../../harnesses/claudeSdk/mcpPolicy.js'

import { createClaudeFileTools, type ClaudeFileSdk } from './sdkServer.js'
export type { ClaudeFileSdk } from './sdkServer.js'
/** Resolves evidence captured by the native owner, never fields from tool arguments.
 * SDK 0.3.284 supplies `extra: unknown`; its installed provider-owned tool-use
 * metadata must resolve through the manager's unique observed root context.
 */
export interface ClaudeFileCallResolver {
  resolve(operation: FileToolOperation, extra: unknown): Promise<ClaudeCallbackIdentity | undefined>
}

/** Call after life admission. Importing/allocating an owner need not load an SDK,
 * create credentials or query native state. No token is exposed to the model.
 */
export function createClaudeFileMcpServer(input: {
  sdk: ClaudeFileSdk
  service: AgentFileToolService
  admission: ClaudeFileAdmission
  calls: ClaudeFileCallResolver
  allowMutation: boolean
}): { server: McpSdkServerConfigWithInstance; manifest: ClaudeMcpToolManifest; close(): Promise<void> } {
  const bridges = new Set<ClaudeFileBridge>()
  let closed = false
  const invoke = async (operation: FileToolOperation, args: unknown, extra: unknown): Promise<CallToolResult> => {
    try {
      if (closed || (isMutation(operation) && !input.allowMutation)) throw new DomainError(
        'CLAUDE_FILE_CONTEXT_DENIED', 'The admitted Claude owner does not allow this file operation.', 403)
      const identity = await input.calls.resolve(operation, extra)
      if (closed || !identity?.ownerPrincipalId || !identity.nativeSessionId || !identity.nativeMessageId
        || identity.nativeTurnId !== undefined || !identity.clientCorrelationId || !identity.attemptId
        || !identity.generation || !identity.toolUseId || identity.agentId || identity.parentToolUseId) {
        throw new DomainError('CLAUDE_FILE_NATIVE_CONTEXT_REQUIRED',
          'An exact observed native message and admitted root callback identity are required.', 403)
      }
      // The resolver binds each call; the bridge re-fetches admission and the
      // existing file service re-fetches the principal/grants for every effect.
      const bridge = new ClaudeFileBridge(identity, input.admission, input.service)
      bridges.add(bridge)
      let result: ReturnType<typeof toolResult>
      try {
        const value = await bridge.call(operation, args)
        result = toolResult(value)
        if (operation === 'files.read') {
          const text = markdownReadText(AgentFileReadResultSchema.parse(value))
          if (text) result.content.push({ type: 'text', text })
        }
      } finally {
        await bridge.close()
        bridges.delete(bridge)
      }
      // The app uses MCP 2; the official Claude SDK uses MCP 1. Project only
      // shared text/structured result fields, without casting server protocols.
      return { content: result.content.filter(value => value.type === 'text').map(value => ({ type: 'text', text: value.text })),
        ...(result.structuredContent ? { structuredContent: Object.fromEntries(Object.entries(result.structuredContent)) } : {}) }
    } catch (error) {
      const result = toolFailure(error, 'The admitted Claude file service could not complete the request.')
      return { isError: true, content: result.content.filter(value => value.type === 'text').map(value => ({ type: 'text', text: value.text })) }
    }
  }
  const { server, manifest } = createClaudeFileTools({ sdk: input.sdk, allowMutation: input.allowMutation, invoke })
  return { server, manifest, close: async () => {
    closed = true
    await Promise.all([...bridges].map(bridge => bridge.close()))
    bridges.clear()
    await server.instance.close()
  } }
}
