import type { SavedRunDetails } from '@foreman-code/contracts/wave25'

export async function waitForHandoffCompletion(
  fixture: { finished: Promise<void>; details(): Promise<SavedRunDetails> },
  description: string,
): Promise<SavedRunDetails> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 30_000) })
  try {
    // Full snapshots validate every execution and activity; reading them while
    // work runs competes with the same database and CPU needed to finish it.
    const finished = await Promise.race([fixture.finished.then(() => true), deadline])
    const details = await fixture.details()
    if (!finished) {
      const agents = details.executions.map(execution => `${execution.workflowNodeId}=${execution.state}`).join(', ')
      throw new Error(`Timed out waiting for ${description}. Run: ${details.run.executionState}. Agents: ${agents}.`, {
        cause: {
          runId: details.run.id,
          outcome: details.run.outcome,
          cleanupPending: details.cleanupPending,
          executions: details.executions.map(execution => ({
            id: execution.id, workflowNodeId: execution.workflowNodeId, state: execution.state,
            nativeSessionId: execution.nativeSessionId, result: execution.result,
          })),
        },
      })
    }
    if (details.run.executionState !== 'completed') {
      throw new Error(`The engine finished with a nonterminal MCP Run: ${details.run.executionState}.`)
    }
    return details
  } finally {
    clearTimeout(timer)
  }
}
