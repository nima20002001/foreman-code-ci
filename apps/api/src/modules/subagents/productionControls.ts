import { isDeepStrictEqual } from 'node:util'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import type { ExecutionScopedNativeSessionManagerResolver } from '../interactions/runtimePorts.js'
import type { SubagentControlResolver } from './types.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

/** Resolve only the original resident allocation. Reads never launch a native process. */
export function productionSubagentControls(managers: Pick<ExecutionScopedNativeSessionManagerResolver, 'residentForRead'>): SubagentControlResolver {
  return child => {
    if (child.provider === 'opencode') return undefined
    let owned: ReturnType<ExecutionScopedNativeSessionManagerResolver['residentForRead']>
    try { owned = managers.residentForRead(child.parentExecutionId) }
    catch (error) {
      logIgnoredError('harness', 'read resident subagent controls', error)
      return undefined
    }
    if (!owned) return undefined
    const { context } = owned
    if (context.purpose || context.runId !== child.runId || context.agentId !== child.parentAgentId
      || context.configuration.workspaceId !== child.workspaceId
      || context.harness !== child.provider || context.attempt === undefined
      || `${context.executionId}:${context.attempt}` !== child.parentAttemptKey) return undefined
    const placement = context.acceptedPlacement
    if (placement && (placement.nodeId !== child.parentNodeId || placement.payload.kind !== 'agent'
      || placement.payload.instanceId !== child.profile.harnessInstanceId
      || (placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : placement.hostRef.mainId) !== child.profile.deviceId)) return undefined
    if (!placement && context.configuration.id !== child.profile.harnessInstanceId) return undefined
    const native = owned.manager.subagentControl?.(child, owned.assertCurrent)
    if (!native) return undefined
    const identity = (value: RunSubagent) => [value.id, value.workspaceId, value.workflowId, value.workflowVersionId, value.runId,
      value.parentExecutionId, value.parentAttemptKey, value.parentAgentId, value.parentNodeId, value.parentSubagentId,
      value.nativeMode, value.native, value.profile]
    const captured = structuredClone(identity(child))
    return {
      ...native,
      generation: JSON.stringify([owned.generation, native.generation]),
      matches(current) {
        try { owned.assertCurrent() }
        catch { return false } // ignore: an ended owner is ordinary unavailability.
        try { return isDeepStrictEqual(captured, identity(current)) && native.matches(current) }
        catch (error) {
          logIgnoredError('harness', 'check resident subagent controls', error)
          return false
        }
      },
      assertCurrent() { owned.assertCurrent(); native.assertCurrent() },
      ...(native.sendInput ? { sendInput: async (receipt, text) => { owned.assertCurrent(); await native.sendInput!(receipt, text) } } : {}),
      ...(native.interrupt ? { interrupt: async receipt => { owned.assertCurrent(); await native.interrupt!(receipt) } } : {}),
      ...(native.reconcile ? { reconcile: async receipt => { owned.assertCurrent(); return native.reconcile!(receipt) } } : {}),
    }
  }
}
