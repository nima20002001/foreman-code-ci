import { expect, it, vi } from 'vitest'
import { EventEmitter, once } from 'node:events'
import type { HookInput } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity } from './interactions.js'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import { memoryClaudeCallbackJournal } from '../../../../test/support/claudeCallbackJournal.js'

const tool = 'mcp__graphql__workspace_list'
const configuration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/profile',
  permissionMode: 'default', sandbox: 'danger-full-access', tools: [tool], permissionRules: [], instructions: '',
  mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1/mcp' } },
}
const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'session' }
const identity: ClaudeCallbackIdentity = {
  ownerPrincipalId: 'owner', nativeSessionId: session.nativeSessionId, nativeMessageId: 'message',
  clientCorrelationId: 'correlation', attemptId: 'request', generation: 'generation', toolUseId: 'tool',
  nativeRequestId: 'permission', nativeRequestType: 'can_use_tool', mcpServer: { name: 'graphql', source: 'dynamic' },
}
function fixture(accepted = configuration, callbackJournal = memoryClaudeCallbackJournal()) {
  const pending = new EventEmitter()
  const validate = vi.fn(async () => {})
  const persisted = vi.fn(async () => false)
  const bridge: ClaudeInteractionBridge = new ClaudeInteractionBridge(accepted, {
    validate, validateResponse: validate, request: value => {
      const response = bridge.waitForResponse(value)
      pending.emit('offered')
      return response
    }, deliveryPersisted: persisted,
    callbackJournal,
  })
  bridge.bindMcpTools([{ serverName: 'graphql', source: { kind: 'http', url: configuration.mcpServers.graphql!.url },
    tools: ['workspace_list', 'workspace_create'] }])
  return { bridge, validate, persisted, callbackJournal, waitForPending: () => once(pending, 'offered', { signal: AbortSignal.timeout(1000) }) }
}

it.each(['read-only', 'workspace-write'] as const)('refuses %s before tool approval is created', sandbox => {
  expect(() => fixture({ ...configuration, sandbox })).toThrow(/Claude requires Full access/)
})

it('retains an explicit Write denial with Full access', async () => {
  const f = fixture({ ...configuration, tools: ['Write'], permissionRules: [{ tool: 'Write', effect: 'deny' }] })
  try {
    expect(await f.bridge.beforeToolUse(identity, 'Write', { file_path: '/fixture/file' })).toMatchObject({ permissionDecision: 'deny' })
    expect(await f.bridge.canUseTool(identity, 'Write', { file_path: '/fixture/file' }, new AbortController().signal)).toMatchObject({ behavior: 'deny' })
    expect(f.bridge.pendingInteractions(session)).toEqual([])
  } finally { f.bridge.close() }
})

it.each(['allow', 'ask', 'deny'] as const)('enforces the saved MCP %s effect after manifest and current authority checks', async effect => {
  const f = fixture({ ...configuration, permissionRules: [{ tool, effect }] })
  try {
    const preflight = await f.bridge.beforeToolUse(identity, tool, {})
    expect(preflight.permissionDecision).toBe(effect === 'allow' ? undefined : effect)
    const decision = f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)
    if (effect === 'ask') {
      await f.waitForPending()
      expect(f.bridge.pendingInteractions(session)).toHaveLength(1)
      await f.bridge.respond(session, identity.nativeRequestId!, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
    }
    expect((await decision).behavior).toBe(effect === 'deny' ? 'deny' : 'allow')
    expect(f.validate).toHaveBeenCalled()
  } finally { f.bridge.close() }
})

it('does not admit a discovered tool omitted from the saved enabled list or a foreign source', async () => {
  const f = fixture()
  expect(await f.bridge.beforeToolUse(identity, 'mcp__graphql__workspace_create', {}))
    .toMatchObject({ permissionDecision: 'deny' })
  expect((await f.bridge.canUseTool(identity, 'mcp__graphql__workspace_create', {}, new AbortController().signal)).behavior).toBe('deny')
  expect(await f.bridge.beforeToolUse({ ...identity, mcpServer: { name: 'graphql', source: 'user' } }, tool, {}))
    .toMatchObject({ permissionDecision: 'deny' })
  expect(f.bridge.pendingInteractions(session)).toEqual([])
})

it.each([
  { selected: 'allow_once', event: 'PostToolUseFailure', outcome: 'failed', semantic: 'approve_once' },
  { selected: 'cancel', event: 'PermissionDenied', outcome: 'permission_denied', semantic: 'cancel' },
] as const)('acknowledges $selected only after qualified $event consumption', async ({ selected, event, semantic }) => {
  const f = fixture()
  try {
    const decision = f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)
    await f.waitForPending()
    expect(f.bridge.pendingInteractions(session)).toHaveLength(1)
    const option = f.bridge.pendingInteractions(session)[0]!.responseOptions.find(value => value.optionId === selected)!
    await f.bridge.respond(session, identity.nativeRequestId!, option)
    expect(await decision).toMatchObject(selected === 'cancel' ? { behavior: 'deny', interrupt: true } : { behavior: 'allow' })
    expect(await f.bridge.deliveryEvidence(session)).toEqual([])
    const callbacks = createClaudeSdkCallbacks({ manager: () => ({
      waitNativeCallbackContext: async () => ({ ...identity }),
      callbackAuthority: () => ({ ownerPrincipalId: identity.ownerPrincipalId, attemptId: identity.attemptId }),
    }) as unknown as ClaudeNativeSessionManager, bridge: f.bridge })
    const hook = callbacks.hooks![event]![0]!.hooks[0]!
    await hook({ hook_event_name: event, session_id: session.nativeSessionId, transcript_path: '/transcript', cwd: '/work',
      tool_use_id: identity.toolUseId, tool_name: tool, mcp_server: identity.mcpServer,
      ...(event === 'PostToolUseFailure' ? { tool_input: {}, error: 'tool failed', is_interrupt: false }
        : { tool_input: {}, reason: 'The selected permission response canceled the tool.' }),
    } as HookInput, identity.toolUseId, { signal: new AbortController().signal })
    expect(await f.bridge.deliveryEvidence(session)).toMatchObject([{ optionId: selected, semantic }])
  } finally { f.bridge.close() }
})

it('retires persisted delivery records and still refuses old callbacks with changed input', async () => {
  const f = fixture()
  try {
    for (let index = 0; index < 300; index++) {
      const callback = { ...identity, toolUseId: `tool-${index}`, nativeRequestId: `permission-${index}` }
      const decision = f.bridge.canUseTool(callback, tool, { index }, new AbortController().signal)
      await f.waitForPending()
      expect(f.bridge.pendingInteractions(session)).toHaveLength(1)
      await f.bridge.respond(session, callback.nativeRequestId, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
      expect((await decision).behavior).toBe('allow')
      await f.bridge.observeToolResult(callback, tool, 'executed')
      f.persisted.mockResolvedValue(true)
    }
    const first = { ...identity, toolUseId: 'tool-0', nativeRequestId: 'permission-0' }
    expect((await f.bridge.canUseTool(first, tool, { index: 0 }, new AbortController().signal)).behavior).toBe('deny')
    await expect(f.bridge.canUseTool(first, tool, { index: 1 }, new AbortController().signal)).rejects.toThrow('different input')
    expect(await f.bridge.deliveryEvidence(session)).toHaveLength(0)
    expect(f.bridge.inspectCallbackAvailability({ ...first, nativeMessageId: 'message', generation: 'generation', nativeRequestType: 'can_use_tool' })).toMatchObject({ reason: 'request_consumed' })
    expect(f.persisted).toHaveBeenCalled()
  } finally { f.bridge.close() }
}, 30_000)

it.each(['submitted', 'uncertain'] as const)('recovers evicted %s callbacks from storage after bridge replacement', async state => {
  const f = fixture()
  const lookup = vi.spyOn(f.callbackJournal, 'forTool')
  try {
    for (let index = 0; index < 300; index++) {
      const callback = { ...identity, toolUseId: `uncertain-tool-${index}`, nativeRequestId: `uncertain-control-${index}` }
      const controller = new AbortController()
      const decision = f.bridge.canUseTool(callback, tool, { index }, controller.signal)
      await f.waitForPending()
      expect(f.bridge.pendingInteractions(session)).toHaveLength(1)
      if (state === 'uncertain') controller.abort()
      else await f.bridge.respond(session, callback.nativeRequestId, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
      expect((await decision).behavior).toBe(state === 'uncertain' ? 'deny' : 'allow')
    }
    const first = { ...identity, toolUseId: 'uncertain-tool-0', nativeRequestId: 'uncertain-control-0' }
    await f.bridge.observeToolResult(first, tool, 'executed')
    expect(lookup).toHaveBeenCalledWith(first)
    const evidence = await f.bridge.deliveryEvidence(session)
    expect(evidence).toHaveLength(state === 'submitted' ? 1 : 0)
    if (state === 'submitted') expect(evidence[0]?.nativeRequestId).toBe(first.nativeRequestId)
    f.bridge.close()
    const restored = fixture(configuration, f.callbackJournal)
    try {
      expect((await restored.bridge.canUseTool(first, tool, { index: 0 }, new AbortController().signal)).behavior).toBe('deny')
      await expect(restored.bridge.canUseTool(first, tool, { index: 1 }, new AbortController().signal))
        .rejects.toThrow('different input')
      expect(await restored.bridge.deliveryEvidence(session)).toEqual(evidence)
      expect(restored.bridge.pendingInteractions(session)).toEqual([])
      const next = { ...identity, toolUseId: 'later-tool', nativeRequestId: 'later-control' }
      const decision = restored.bridge.canUseTool(next, tool, { index: 300 }, new AbortController().signal)
      await restored.waitForPending()
      expect(restored.bridge.pendingInteractions(session)).toHaveLength(1)
      await restored.bridge.respond(session, next.nativeRequestId, restored.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
      expect((await decision).behavior).toBe('allow')
    } finally { restored.bridge.close() }
  } finally { lookup.mockRestore(); f.bridge.close() }
}, 30_000)

it('retries acknowledgment storage without resending a completed native permission decision', async () => {
  const f = fixture()
  try {
    const decision = f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)
    await f.waitForPending()
    expect(f.bridge.pendingInteractions(session)).toHaveLength(1)
    await f.bridge.respond(session, identity.nativeRequestId!, f.bridge.pendingInteractions(session)[0]!.responseOptions[0]!)
    expect((await decision).behavior).toBe('allow')
    const failure = vi.spyOn(f.callbackJournal, 'write').mockRejectedValueOnce(new Error('Acknowledgment save lost'))
    await expect(f.bridge.observeToolResult(identity, tool, 'executed')).rejects.toThrow('Acknowledgment save lost')
    failure.mockRestore()
    expect(await f.bridge.deliveryEvidence(session)).toMatchObject([{ nativeRequestId: identity.nativeRequestId,
      nativeIdentity: { nativeMessageId: identity.nativeMessageId, generation: identity.generation } }])
    expect(f.bridge.pendingInteractions(session)).toEqual([])
    expect((await f.bridge.canUseTool(identity, tool, {}, new AbortController().signal)).behavior).toBe('deny')
  } finally { f.bridge.close() }
})
