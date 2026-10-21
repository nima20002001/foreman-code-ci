import type { HarnessExecution } from '@foreman-code/contracts'
import { readUntil } from './observableCondition.js'

type StartupExecution = Pick<HarnessExecution, 'id' | 'workflowNodeId' | 'state' | 'result'>

type Startup = {
  entryNodeId: string
  readExecutions(): Promise<StartupExecution[]>
  readCalls(): Promise<Array<Record<string, unknown>>>
  reconcile(): Promise<void>
  subscribe?: (changed: () => void) => () => void
}

export async function waitForRequesterSession(startup: Startup) {
  const options = {
    timeoutMs: 90_000,
    minimumReadIntervalMs: 1_000,
    ...(startup.subscribe ? { subscribe: startup.subscribe } : {}),
  }
  const readExecutions = async () => {
    await startup.reconcile()
    const executions = await startup.readExecutions()
    const failed = executions.find(execution => execution.result?.outcome === 'failed')
    if (failed) {
      throw new Error(`Run execution failed before requester session acknowledgment: ${JSON.stringify({
        executionId: failed.id, state: failed.state, errorCode: failed.result?.error?.code,
      })}`)
    }
    return executions
  }
  // The execution edge admits the requester after the reviewer's workflow turn settles.
  await readUntil(async () => (await readExecutions()).find(execution =>
    execution.workflowNodeId === startup.entryNodeId),
  reviewer => reviewer?.state === 'completed' && reviewer.result?.outcome === 'succeeded', {
    ...options, description: 'completed reviewer workflow turn',
  })
  return readUntil(async () => {
    await readExecutions()
    return startup.readCalls()
  }, calls => calls.some(call => 'requesterSessionBlocked' in call), {
    ...options, description: 'requester thread creation before session acknowledgment',
  })
}
