import { HarnessExecutionError } from '../errors.js'
import type { NativeMcpInspector } from '../mcpDetection.js'
import type { NativeSessionStart } from '../port.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import { createClaudeEventNormalizer, type ClaudeEventOwner } from './normalization.js'
import { claudeNativeEvent } from './nativeEvents.js'
import { createClaudeNativeSessionManager, type ClaudeNativeSessionManager } from './sessionManager.js'

type ManagerOptions = Parameters<typeof createClaudeNativeSessionManager>[0]
export interface ClaudeNativeAllocation extends Omit<ManagerOptions, 'decode' | 'decodeFactory' | 'appMcpAccess'> {
  harness: 'claude'
  role: 'workflow' | 'operator' | 'agent-chat' | 'diagnostics' | 'qualification'
  workingDirectory: string
  ownerAgentId: string
  processRecovery?: NativeProcessRecovery
  appMcpAccess: 'scoped' | 'none'
  credentialEnvironmentVariable?: string
  /** Obtained from admitted ownership, not from a source Run/native UUID. */
  ownerForStart(start: NativeSessionStart): ClaudeEventOwner
  inspector?: NativeMcpInspector
}
export interface ClaudeNativeAllocationResult {
  harness: 'claude'
  manager: ClaudeNativeSessionManager
  inspector?: NativeMcpInspector
}

/** Common HRT factory callback. Construction has no native I/O; the injected
 * runner and accepted scope/options are mandatory in both native and replay.
 * Process reservation/preflight stays with the existing admission coordinator. */
export function allocateClaudeNativeHarness(input: ClaudeNativeAllocation): ClaudeNativeAllocationResult {
  if (input.scope.cwd !== input.workingDirectory) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH',
    'Claude allocation requires the exact accepted working directory.')
  if (['agent-chat', 'diagnostics', 'qualification'].includes(input.role)
    && (input.appMcpAccess !== 'none' || input.credentialEnvironmentVariable)) {
    throw new HarnessExecutionError('HARNESS_ROLE_AUTHORITY_INVALID', 'This runtime role has no application MCP credentials.')
  }
  const now = input.now ?? (() => new Date().toISOString())
  const manager = createClaudeNativeSessionManager({
    runner: input.runner, scope: { ...input.scope }, sdkOptions: { ...input.sdkOptions },
    qualification: { ...input.qualification }, now, appMcpAccess: input.appMcpAccess === 'scoped' ? 'management' : 'none',
    ...(input.inspectionStart ? { inspectionStart: input.inspectionStart } : {}),
    ...(input.expectedMcp ? { expectedMcp: input.expectedMcp } : {}),
    ...(input.credentialEnvironmentVariables ? { credentialEnvironmentVariables: input.credentialEnvironmentVariables } : {}),
    ...(input.supportedInteractionKinds ? { supportedInteractionKinds: input.supportedInteractionKinds } : {}),
    ...(input.pendingInteractions ? { pendingInteractions: input.pendingInteractions } : {}),
    ...(input.responseDeliveries ? { responseDeliveries: input.responseDeliveries } : {}),
    ...(input.messageSubmitted ? { messageSubmitted: input.messageSubmitted } : {}),
    ...(input.interactionPort ? { interactionPort: input.interactionPort } : {}),
    ...(input.liveCallbacks ? { liveCallbacks: input.liveCallbacks } : {}),
    ...(input.cancelPendingRequests ? { cancelPendingRequests: input.cancelPendingRequests } : {}),
    ...(input.initializationTimeoutMs !== undefined ? { initializationTimeoutMs: input.initializationTimeoutMs } : {}),
    decodeFactory(start) {
      const normalizer = createClaudeEventNormalizer({ owner: input.ownerForStart(start), observedAt: now })
      return (raw) => normalizer.ingest(raw).map((event) => {
        const mapped = claudeNativeEvent(event, 0)
        // The real manager supplies its transport cursor after native emission.
        return { type: mapped.type, payload: mapped.payload }
      })
    },
  })
  return { harness: 'claude', manager, ...(input.inspector ? { inspector: input.inspector } : {}) }
}
