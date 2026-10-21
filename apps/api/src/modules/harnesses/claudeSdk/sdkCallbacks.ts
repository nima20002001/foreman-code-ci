import type { CanUseTool, HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeCallbackIdentity } from './interactions.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'

/** The existing B bridge is injected, never replaced by another response/interaction store. */
export interface ClaudeSdkPolicyBridge {
  observeToolResult?(identity: ClaudeCallbackIdentity, toolName: string, outcome: 'executed' | 'failed' | 'permission_denied'): Promise<void>
  beforeToolUse(identity: {
    ownerPrincipalId: string; attemptId: string; nativeSessionId: string; nativeMessageId: string
    generation: string; toolUseId: string; agentId?: string; mcpServer?: { name: string; source: string }
  }, toolName: string, input: Record<string, unknown>): Promise<{ permissionDecision?: 'deny' | 'ask'; permissionDecisionReason?: string }>
  canUseTool(identity: {
    ownerPrincipalId: string; attemptId: string; nativeSessionId: string; nativeMessageId: string
    generation: string; toolUseId: string; nativeRequestId: string; nativeRequestType: 'can_use_tool'; agentId?: string; mcpServer?: { name: string; source: string }
  }, toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean }>
}

export function createClaudeSdkCallbacks(input: {
  manager(): ClaudeNativeSessionManager
  bridge: ClaudeSdkPolicyBridge
}): Pick<Options, 'canUseTool' | 'hooks'> {
  const canUseTool: CanUseTool = async (name, value, options) => {
    if (options.agentID) return { behavior: 'deny', message: 'Native child tool callbacks are not qualified.' }
    if (!options.requestId || !options.toolUseID) return { behavior: 'deny', message: 'Exact native control request identity is unavailable.' }
    try {
      const context = await input.manager().waitNativeCallbackContext(options.toolUseID, options.signal)
      const authority = input.manager().callbackAuthority(context)
      if (!authority) return { behavior: 'deny', message: 'No admitted message authority matches the native callback.' }
      return await input.bridge.canUseTool({ ...context, ...authority,
        toolUseId: options.toolUseID, nativeRequestId: options.requestId, nativeRequestType: 'can_use_tool',
        ...(options.mcpServer ? { mcpServer: options.mcpServer } : {}) }, name, value, options.signal)
    } catch {
      return { behavior: 'deny', message: 'The admitted native callback context is unavailable.', interrupt: options.signal.aborted }
    }
  }
  const beforeToolUse: HookCallback = async (hook, suppliedToolId, options) => {
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const,
      permissionDecisionReason: 'The admitted native tool context is unavailable.' } }
    if (hook.hook_event_name !== 'PreToolUse' || !hook.tool_input || typeof hook.tool_input !== 'object' || Array.isArray(hook.tool_input) || !hook.tool_use_id || suppliedToolId && suppliedToolId !== hook.tool_use_id) return deny
    try {
      const context = await input.manager().waitNativeCallbackContext(hook.tool_use_id, options.signal, hook.session_id)
      const authority = input.manager().callbackAuthority(context)
      if (!authority) return deny
      const decision = await input.bridge.beforeToolUse({ ...context, ...authority, toolUseId: hook.tool_use_id,
        ...(hook.mcp_server ? { mcpServer: hook.mcp_server } : {}) }, hook.tool_name, hook.tool_input as Record<string, unknown>)
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }
    } catch { return deny }
  }
  const afterToolUse: HookCallback = async (hook, suppliedToolId, options) => {
    if (hook.hook_event_name !== 'PostToolUse' && hook.hook_event_name !== 'PostToolUseFailure'
      && hook.hook_event_name !== 'PermissionDenied') return {}
    if (!hook.tool_use_id
      || suppliedToolId && suppliedToolId !== hook.tool_use_id) return {}
    const context = await input.manager().waitNativeCallbackContext(hook.tool_use_id, options.signal, hook.session_id)
    const authority = input.manager().callbackAuthority(context)
    if (authority) await input.bridge.observeToolResult?.({ ...context, ...authority, toolUseId: hook.tool_use_id,
      ...(hook.mcp_server ? { mcpServer: hook.mcp_server } : {}) }, hook.tool_name,
      hook.hook_event_name === 'PostToolUse' ? 'executed'
        : hook.hook_event_name === 'PostToolUseFailure' ? 'failed' : 'permission_denied')
    return {}
  }
  const observeChild: HookCallback = async (hook) => {
    if (hook.hook_event_name === 'SubagentStart' || hook.hook_event_name === 'SubagentStop') {
      input.manager().observeSubagentHook?.(hook.session_id, hook.agent_id, hook.agent_type, hook.hook_event_name === 'SubagentStart' ? 'running' : 'unknown')
    }
    return {}
  }
  return { canUseTool, hooks: { PreToolUse: [{ hooks: [beforeToolUse] }], PostToolUse: [{ hooks: [afterToolUse] }], PostToolUseFailure: [{ hooks: [afterToolUse] }], PermissionDenied: [{ hooks: [afterToolUse] }], SubagentStart: [{ hooks: [observeChild] }], SubagentStop: [{ hooks: [observeChild] }] } }
}
