import { describe, expect, it, vi } from 'vitest'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import { createClaudeSdkCallbacks, type ClaudeSdkPolicyBridge } from './sdkCallbacks.js'
const context = { nativeSessionId: 'observed-session', nativeMessageId: 'observed-input-message', clientCorrelationId: 'exact-request', generation: 'owned-runtime-generation' }
function fixture() {
  const wait = vi.fn(async () => context)
  const bridge = { beforeToolUse: vi.fn<ClaudeSdkPolicyBridge['beforeToolUse']>(async () => ({ permissionDecision: 'ask' as const })),
    canUseTool: vi.fn<ClaudeSdkPolicyBridge['canUseTool']>(async () => ({ behavior: 'allow' as const, updatedInput: { accepted: true } })) }
  const authority = vi.fn(() => ({ ownerPrincipalId: 'owner', attemptId: 'attempt' }))
  const adapter = createClaudeSdkCallbacks({ manager: () => ({ waitNativeCallbackContext: wait, callbackAuthority: authority }) as unknown as ClaudeNativeSessionManager,
    bridge })
  return { wait, bridge, adapter, authority }
}

describe('official SDK native control identity adaptation', () => {
  it('forwards actual requestId separately from toolUseID after proven native context', async () => {
    const f = fixture(); const signal = new AbortController().signal
    expect(await f.adapter.canUseTool!('Read', { file_path: '/work/file' }, { signal, toolUseID: 'actual-tool', requestId: 'actual-control-request' })).toEqual({ behavior: 'allow', updatedInput: { accepted: true } })
    expect(f.wait).toHaveBeenCalledWith('actual-tool', signal)
    expect(f.bridge.canUseTool).toHaveBeenCalledWith(expect.objectContaining({ ownerPrincipalId: 'owner', attemptId: 'attempt',
      nativeSessionId: context.nativeSessionId, nativeMessageId: context.nativeMessageId, generation: context.generation,
      toolUseId: 'actual-tool', nativeRequestId: 'actual-control-request', nativeRequestType: 'can_use_tool' }), 'Read', { file_path: '/work/file' }, signal)
    expect(f.bridge.canUseTool.mock.calls[0]?.[0]).not.toHaveProperty('nativeTurnId')
  })
  it('denies child/missing request IDs and never derives a request ID from the tool ID', async () => {
    const f = fixture(); const signal = new AbortController().signal
    expect((await f.adapter.canUseTool!('Read', {}, { signal, toolUseID: 'tool', requestId: '', agentID: 'child' }))?.behavior).toBe('deny')
    expect((await f.adapter.canUseTool!('Read', {}, { signal, toolUseID: 'tool', requestId: '' }))?.behavior).toBe('deny')
    expect(f.wait).not.toHaveBeenCalled(); expect(f.bridge.canUseTool).not.toHaveBeenCalled()
  })
  it('returns explicit native PreToolUse denial/ask wrapper and never supplies a control request ID', async () => {
    const f = fixture(); const signal = new AbortController().signal
    const hook = f.adapter.hooks!.PreToolUse![0]!.hooks[0]!
    const input = { hook_event_name: 'PreToolUse', session_id: 'observed-session', transcript_path: '/native/transcript', cwd: '/work',
      tool_use_id: 'actual-tool', tool_name: 'Read', tool_input: { file_path: '/work/file' } } as HookInput
    expect(await hook(input, 'actual-tool', { signal })).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } })
    expect(f.wait).toHaveBeenCalledWith('actual-tool', signal, 'observed-session')
    expect(f.bridge.beforeToolUse.mock.calls[0]?.[0]).not.toHaveProperty('nativeRequestId')
    f.wait.mockRejectedValueOnce(new Error('context closed'))
    expect(await hook(input, 'actual-tool', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })
  it('uses each proven message admission authority and denies absent/stale message authority', async () => {
    const f = fixture(); const signal = new AbortController().signal
    await f.adapter.canUseTool!('Read', {}, { signal, toolUseID: 'tool-A', requestId: 'rpc-A' })
    f.wait.mockResolvedValue({ ...context, nativeMessageId: 'message-B', clientCorrelationId: 'request-B' })
    f.authority.mockReturnValue({ ownerPrincipalId: 'sender-B', attemptId: 'attempt-B' })
    await f.adapter.canUseTool!('Read', {}, { signal, toolUseID: 'tool-B', requestId: 'rpc-B' })
    expect(f.bridge.canUseTool).toHaveBeenLastCalledWith(expect.objectContaining({ ownerPrincipalId: 'sender-B', attemptId: 'attempt-B', nativeMessageId: 'message-B' }), 'Read', {}, signal)
    f.authority.mockReturnValue(undefined as never)
    expect((await f.adapter.canUseTool!('Read', {}, { signal, toolUseID: 'tool-C', requestId: 'rpc-C' }))?.behavior).toBe('deny')
    expect(f.bridge.canUseTool).toHaveBeenCalledTimes(2)
  })

})
