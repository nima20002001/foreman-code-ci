import { setTimeout as delay } from 'node:timers/promises'
import { type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import type { RepeatRunRepository } from './repeatPostgres.js'
import type { RepeatExecutionDriver } from './repeatNode.js'
import { ExecutionLimiter } from './limiter.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'
import { WorkExecutionFailure } from './workExecutionFailure.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'
import { waitBeforeRetry } from './executionRetryPolicy.js'
import { parseHierarchyWorkResult } from './hierarchyResults.js'

/** One LangGraph activation task. Every durable decision is idempotent, so a
 * checkpoint replay reconciles the exact native execution and work receipts. */
export function workHandoffNodeAction(input: {
  version: WorkflowVersionV3
  store: Pick<RepeatRunRepository, 'admitWorkActivation' | 'acceptWorkTerminal' | 'admitWorkRequest'
    | 'returnWork' | 'recordWorkUnresolved' | 'resolveWaitingWorkJoins'>
    & Partial<Pick<RepeatRunRepository, 'admitHierarchyGroup'>>
  driver: RepeatExecutionDriver; limiter: ExecutionLimiter; signal: AbortSignal
}) {
  const execute = async (activationId: string): Promise<readonly string[]> => {
    input.signal.throwIfAborted()
    const admit = () => input.store.admitWorkActivation(activationId,
      (nodeId) => input.driver.candidate({ nodeId, occurrence: null }, 1))
    let admitted
    for (;;) {
      try { admitted = await admit(); break }
      catch (error) {
        // The node's interval check finishes first; its slot is not held while waiting.
        if (!(error instanceof DomainError
          && ['INTERVAL_CHECK_RUNNING','HIERARCHY_DIRECTION_WAITING','COORDINATOR_CONSULTATION_ACTIVE'].includes(error.code))) throw error
        await delay(1_000, undefined, { signal: input.signal })
      }
    }
    let execution = admitted.execution
    for (;;) {
      input.signal.throwIfAborted()
      try {
        if (execution.state === 'completed') await input.driver.observe(execution, input.signal)
        else await input.limiter.run(input.signal, () => input.driver.observe(execution, input.signal), execution)
      } catch (error) {
        input.signal.throwIfAborted()
        if (!(error instanceof DomainError)
          || !['APP_MCP_PREFLIGHT_FAILED', 'APP_MCP_PREFLIGHT_TIMEOUT', 'HARNESS_PROFILE_UNAVAILABLE']
            .includes(error.code)) throw error
        const failure = new WorkExecutionFailure({ outcome: 'failed', error: {
          code: error.code, message: error.message, retryable: false,
        } }, execution.id)
        failure.cause = error
        throw failure
      }
      const terminal = await input.store.acceptWorkTerminal(execution.id,
        (attempt) => input.driver.candidate({ nodeId: execution.workflowNodeId, occurrence: null }, attempt))
      if (terminal.kind === 'retry' || terminal.kind === 'continued') {
        if (terminal.kind === 'retry') await waitBeforeRetry(execution, terminal.execution, input.signal)
        execution = terminal.execution
        continue
      }
      if (terminal.kind === 'waiting_direction') return [terminal.activationId]
      if (terminal.kind === 'refused') return []
      if (input.version.definition.hierarchy) {
        const result = parseHierarchyWorkResult(terminal.execution.result, input.version,
          terminal.execution.workflowNodeId, terminal.resultProtocol)
        if (result.routing.kind === 'return') {
          return (await input.store.returnWork(terminal.execution.id)).destinations ?? []
        }
        if (result.routing.kind === 'delegate' || result.routing.kind === 'request') {
          if (!input.store.admitHierarchyGroup) throw new DomainError('HIERARCHY_ENGINE_REQUIRED',
            'Hierarchy work requires the existing Run group admission owner.', 409)
          const group = await input.store.admitHierarchyGroup(terminal.execution.id)
          return group.kind === 'accepted' ? group.requests.map(request => request.destinationActivationId) : []
        }
        return []
      }
      const result = parseWorkflowWorkResult(terminal.execution.result!, input.version,
        terminal.execution.workflowNodeId, terminal.resultProtocol)
      if (result.routing.kind === 'return') {
        const returned = await input.store.returnWork(terminal.execution.id)
        return returned.destinations ?? []
      }
      const selected: string[] = []
      if (result.routing.kind === 'request') {
        const admitted = await input.store.admitWorkRequest(terminal.execution.id)
        if (admitted.kind === 'limit_reached') return [admitted.notice.continuationActivationId]
        if (admitted.kind === 'needs_direction') return []
        if (admitted.destinationReady) selected.push(admitted.request.destinationActivationId)
      } else {
        const routes = selectedWorkHandoffRoutes(input.version.definition, execution.workflowNodeId, result)
        for (const relationshipId of routes) {
          const admitted = await input.store.admitWorkRequest(terminal.execution.id, relationshipId)
          if (admitted.kind === 'limit_reached') {
            selected.push(admitted.notice.continuationActivationId)
            continue
          }
          if (admitted.kind === 'needs_direction') continue
          if (admitted.destinationReady) selected.push(admitted.request.destinationActivationId)
        }
        if (!routes.length && result.data.remainingFindings.length) {
          await input.store.recordWorkUnresolved(terminal.execution.id)
        }
      }
      return [...new Set(selected)]
    }
  }
  return async (activationId: string): Promise<readonly string[]> => {
    const selected = await execute(activationId)
    const joined = await input.store.resolveWaitingWorkJoins(activationId)
    return [...new Set([...selected, ...joined])]
  }
}
